// SABR-Streaming für Shaka – so lädt auch der YouTube-Webplayer. YouTube liefert bei den Web-Clients
// oft nur noch über SABR mehr als 360p: Der Player fragt dabei per POST nach dem nächsten Stück und
// bekommt es im UMP-Format zurück. Das Protokoll erledigt "googlevideo" (LuanRT), die Anbindung an
// Shaka folgt dem Beispiel aus LuanRT/googlevideo (examples/sabr-shaka-example, MIT-Lizenz).

import { SabrStreamingAdapter, SabrUmpProcessor, createSegmentCacheKeyFromMetadata, getUniqueFormatId } from './vendor/googlevideo.js';

const shaka = window.shaka;
const UMP_TYPE = 'application/vnd.yt-ump';

function isGoogleVideoURL(url) {
  if (url.startsWith('sabr://')) return true;
  const [urlPart, queryPart = ''] = url.split('?');
  if (urlPart.endsWith('/videoplayback')) {
    const params = new URLSearchParams(queryPart);
    return params.get('source') === 'youtube' || params.has('sabr') || params.has('lsig') || params.has('expire');
  }
  if (urlPart.includes('/videoplayback/')) {
    const parts = urlPart.split('/');
    return ['videoplayback', 'sabr', 'lsig', 'expire'].some((p) => parts.includes(p));
  }
  return false;
}

function recoverable(message, info) {
  return new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK, shaka.util.Error.Code.HTTP_ERROR, message, { info });
}

function headersObject(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key.trim()] = value;
  });
  return out;
}

function makeResponse(headers, data, status, uri, responseURL, request, requestType) {
  if (status >= 200 && status <= 299 && status !== 202) {
    return { uri: responseURL || uri, originalUri: uri, data, status, headers, originalRequest: request, fromCache: Boolean(headers['x-shaka-from-cache']) };
  }
  let text = null;
  try {
    text = shaka.util.StringUtils.fromBytesAutoDetect(data);
  } catch {
    // egal
  }
  const severity = status === 401 || status === 403 ? shaka.util.Error.Severity.CRITICAL : shaka.util.Error.Severity.RECOVERABLE;
  throw new shaka.util.Error(severity, shaka.util.Error.Category.NETWORK, shaka.util.Error.Code.BAD_HTTP_STATUS, uri, status, text, headers, requestType, responseURL || uri);
}

/** Verbindet den SabrStreamingAdapter mit Shaka: eigene Netzwerk-Schicht für die UMP-Antworten. */
class ShakaSabrAdapter {
  player = null;
  requestMetadataManager = null;
  cacheManager = null;
  abortController = null;
  requestFilter = null;
  responseFilter = null;

  initialize(player, requestMetadataManager, cacheManager) {
    this.player = player;
    this.requestMetadataManager = requestMetadataManager;
    this.cacheManager = cacheManager;
    // Shaka 5 sucht die Netzwerk-Schicht schon vor den Filtern aus, die sabr:// in https:// umschreiben –
    // deshalb gehört auch "sabr" zu uns
    for (const scheme of ['http', 'https', 'sabr']) {
      shaka.net.NetworkingEngine.registerScheme(scheme, this.parseRequest.bind(this), shaka.net.NetworkingEngine.PluginPriority.APPLICATION);
    }
  }

  parseRequest(uri, request, requestType, progressUpdated, headersReceived, config) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) headers.append(key, value);
    const controller = new AbortController();
    this.abortController = controller;
    const init = {
      body: request.body || undefined,
      headers,
      method: request.method,
      signal: controller.signal,
      credentials: request.allowCrossSiteCredentials ? 'include' : undefined,
    };
    const abortStatus = { canceled: false, timedOut: false };
    const pending = this.request(uri, request, requestType, init, controller, abortStatus, progressUpdated, headersReceived, config.minBytesForProgressEvents || 0);
    const operation = new shaka.util.AbortableOperation(pending, () => {
      abortStatus.canceled = true;
      controller.abort();
      return Promise.resolve();
    });
    const timeoutMs = request.retryParameters.timeout;
    if (timeoutMs) {
      const timer = new shaka.util.Timer(() => {
        abortStatus.timedOut = true;
        controller.abort();
      });
      timer.tickAfter(timeoutMs / 1000);
      operation.finally(() => timer.stop());
    }
    return operation;
  }

  async handleCachedRequest(meta, uri, request, progressUpdated, headersReceived, requestType) {
    if (!meta.byteRange || !this.cacheManager) return null;
    const key = createSegmentCacheKeyFromMetadata(meta);
    let buffer = (meta.isInit ? this.cacheManager.getInitSegment(key) : this.cacheManager.getSegment(key))?.buffer;
    if (!buffer) return null;
    if (meta.isInit) buffer = buffer.slice(meta.byteRange.start, meta.byteRange.end + 1);
    const headers = { 'content-type': meta.format?.mimeType?.split(';')[0] || '', 'content-length': String(buffer.byteLength), 'x-shaka-from-cache': 'true' };
    headersReceived(headers);
    progressUpdated(0, buffer.byteLength, 0);
    return makeResponse(headers, buffer, 200, uri, uri, request, requestType);
  }

  async handleUmpResponse(response, meta, uri, request, requestType, progressUpdated, controller, minBytes) {
    let lastTime = Date.now();
    const reader = new SabrUmpProcessor(meta, this.cacheManager);
    const checkIntegrity = (result) => {
      if (!result.data && (Boolean(meta.error) || meta.streamInfo?.streamProtectionStatus?.status === 3) && !meta.streamInfo?.sabrContextUpdate) {
        throw recoverable('Server streaming error', meta);
      }
    };
    const emptyIsFine = () => meta.isSABR && (meta.streamInfo?.redirect || meta.streamInfo?.sabrContextUpdate);
    const respond = (data) => this.createShakaResponse(uri, request, requestType, response, data);
    try {
      if (!response.body) {
        const buffer = await response.arrayBuffer();
        progressUpdated(Date.now() - lastTime, buffer.byteLength, 0);
        const result = await reader.processChunk(new Uint8Array(buffer));
        if (result) {
          checkIntegrity(result);
          return respond(result.data);
        }
        if (emptyIsFine()) return respond(undefined);
        throw recoverable('Empty response with no redirect information', meta);
      }
      const body = response.body.getReader();
      let loaded = 0;
      let lastLoaded = 0;
      let contentLength;
      while (!controller.signal.aborted) {
        let chunk;
        try {
          chunk = await body.read();
        } catch {
          break; // abgebrochen
        }
        const { value, done } = chunk;
        if (done) {
          // Ganz gelesen, aber kein Stück: Weiterleitung oder Protokoll-Update folgt
          if (emptyIsFine()) return respond(undefined);
          throw recoverable('Empty response with no redirect information', meta);
        }
        const result = await reader.processChunk(value);
        const info = reader.getSegmentInfo();
        if (info) {
          contentLength ??= info.mediaHeader.segmentLengthBytes;
          loaded += info.lastChunkSize || 0;
          info.lastChunkSize = 0;
        }
        const now = Date.now();
        const size = loaded - lastLoaded;
        if ((now - lastTime > 100 && size >= minBytes) || result) {
          if (result) checkIntegrity(result);
          if (contentLength) {
            try {
              progressUpdated(now - lastTime, size, result ? 0 : parseInt(contentLength, 10) - loaded);
            } catch {
              // egal
            } finally {
              lastLoaded = loaded;
              lastTime = now;
            }
          }
        }
        if (result) {
          controller.abort();
          return respond(result.data);
        }
      }
      throw recoverable('UMP stream processing was aborted but did not produce a result.', meta);
    } finally {
      reader.dispose();
    }
  }

  async request(uri, request, requestType, init, controller, abortStatus, progressUpdated, headersReceived, minBytes) {
    try {
      const meta = this.requestMetadataManager?.getRequestMetadata(uri);
      if (meta) {
        const cached = await this.handleCachedRequest(meta, uri, request, progressUpdated, headersReceived, requestType);
        if (cached) return cached;
      }
      const response = await fetch(uri, init);
      headersReceived(headersObject(response.headers));
      if (meta && init.method !== 'HEAD' && response.headers.get('content-type') === UMP_TYPE) {
        return this.handleUmpResponse(response, meta, uri, request, requestType, progressUpdated, controller, minBytes);
      }
      const start = Date.now();
      const buffer = await response.arrayBuffer();
      progressUpdated(Date.now() - start, buffer.byteLength, 0);
      return this.createShakaResponse(uri, request, requestType, response, buffer);
    } catch (error) {
      if (error instanceof shaka.util.Error) throw error;
      const code = abortStatus.canceled ? shaka.util.Error.Code.OPERATION_ABORTED : abortStatus.timedOut ? shaka.util.Error.Code.TIMEOUT : shaka.util.Error.Code.HTTP_ERROR;
      throw new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK, code, uri, error, requestType);
    }
  }

  getPlayerTime() {
    return this.player?.getMediaElement()?.currentTime || 0;
  }

  getPlaybackRate() {
    return this.player?.getPlaybackRate() ?? 1;
  }

  getBandwidthEstimate() {
    return this.player?.getStats().estimatedBandwidth ?? 0;
  }

  getActiveTrackFormats(activeFormat, sabrFormats) {
    const active = this.player?.getVariantTracks().find((t) => getUniqueFormatId(activeFormat) === (activeFormat.width ? t.originalVideoId : t.originalAudioId));
    if (!active) return { videoFormat: undefined, audioFormat: undefined };
    const byId = new Map(sabrFormats.map((f) => [getUniqueFormatId(f), f]));
    return {
      videoFormat: active.originalVideoId ? byId.get(active.originalVideoId) : undefined,
      audioFormat: active.originalAudioId ? byId.get(active.originalAudioId) : undefined,
    };
  }

  registerRequestInterceptor(interceptor) {
    const engine = this.player?.getNetworkingEngine();
    if (!engine) return;
    this.requestFilter = async (type, request, context) => {
      if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT || !isGoogleVideoURL(request.uris[0])) return;
      const modified = await interceptor({
        headers: request.headers,
        url: request.uris[0],
        method: request.method,
        segment: {
          getStartTime: () => context?.segment?.getStartTime() ?? null,
          isInit: () => !context?.segment,
        },
        body: request.body,
      });
      if (modified) {
        request.uris = modified.url ? [modified.url] : request.uris;
        request.method = modified.method || request.method;
        request.headers = modified.headers || request.headers;
        request.body = modified.body || request.body;
      }
    };
    engine.registerRequestFilter(this.requestFilter);
  }

  registerResponseInterceptor(interceptor) {
    const engine = this.player?.getNetworkingEngine();
    if (!engine) return;
    this.responseFilter = async (type, response, context) => {
      if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT || !isGoogleVideoURL(response.uri)) return;
      const modified = await interceptor({
        url: response.originalRequest.uris[0],
        method: response.originalRequest.method,
        headers: response.headers,
        data: response.data,
        makeRequest: async (url, headers) => {
          const retry = this.player.getConfiguration().streaming.retryParameters;
          const followup = shaka.net.NetworkingEngine.makeRequest([url], retry);
          Object.assign(followup.headers, headers);
          const result = await engine.request(type, followup, context).promise;
          return { url: result.uri, method: result.originalRequest.method, headers: result.headers, data: result.data };
        },
      });
      if (modified) {
        response.data = modified.data ?? response.data;
        Object.assign(response.headers, modified.headers);
      }
    };
    engine.registerResponseFilter(this.responseFilter);
  }

  createShakaResponse(uri, request, requestType, response, data) {
    return makeResponse(headersObject(response.headers), data || new ArrayBuffer(0), response.status, uri, response.url, request, requestType);
  }

  dispose() {
    this.abortController?.abort();
    this.abortController = null;
    const engine = this.player?.getNetworkingEngine();
    if (engine && this.requestFilter) engine.unregisterRequestFilter(this.requestFilter);
    if (engine && this.responseFilter) engine.unregisterResponseFilter(this.responseFilter);
    // Shakas eigene Netzwerk-Schicht wieder einsetzen (für normale Videos)
    shaka.net.NetworkingEngine.unregisterScheme('sabr');
    for (const scheme of ['http', 'https']) {
      shaka.net.NetworkingEngine.unregisterScheme(scheme);
      shaka.net.NetworkingEngine.registerScheme(scheme, shaka.net.HttpFetchPlugin.parse, shaka.net.NetworkingEngine.PluginPriority.PREFERRED, true);
    }
    this.player = null;
  }
}

/**
 * SABR für einen Stream einrichten. [sabr] kommt vom Hauptprozess (Adresse, Formate, Client …),
 * [mintPoToken] liefert das PO-Token fürs Video, [reload] holt neue Adressen, wenn YouTube das verlangt.
 */
export function attachSabr(player, sabr, { mintPoToken, reload }) {
  const adapter = new SabrStreamingAdapter({ playerAdapter: new ShakaSabrAdapter(), clientInfo: sabr.clientInfo });
  // PO-Token nur für Web-Clients (mit Konto über TV gibt es keins)
  if (!sabr.noPoToken) {
    let token = sabr.poToken || '';
    adapter.onMintPoToken(async () => {
      if (!token) token = (await mintPoToken().catch(() => '')) || '';
      return token;
    });
  }
  adapter.onReloadPlayerResponse(async (reloadContext) => {
    // Den Kontext aus der Reload-Aufforderung mitschicken – ohne ihn lehnt YouTube manche Videos ab
    const fresh = await reload(reloadContext);
    if (fresh?.url) adapter.setStreamingURL(fresh.url);
    if (fresh?.ustreamerConfig) adapter.setUstreamerConfig(fresh.ustreamerConfig);
  });
  adapter.attach(player);
  adapter.setStreamingURL(sabr.url);
  adapter.setUstreamerConfig(sabr.ustreamerConfig);
  adapter.setServerAbrFormats(sabr.formats);
  return adapter;
}
