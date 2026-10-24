// Runs inside Twitch's video player Web Worker (prepended by twitch_main.js).
//
// Twitch stitches ads into the live HLS media playlist: ad segments have an #EXTINF title other
// than "live" (e.g. "Amazon|123") and there are DATERANGE tags of class "twitch-stitched-ad".
// Ads are per playback session, so another session of the same stream (requested with another
// player type, "backup") is often ad-free at the same moment.
//
// Several techniques follow TTV-AB by GosuDRM (https://github.com/GosuDRM/TTV-AB, MIT license
// with attribution): the 360p "autoplay" session (platform android) as a quick bridge, a second
// look before trusting a full-quality backup, codec-matched backup variants, returning to the
// player's own session after the ad on one continuous timeline, and a blank hold segment with
// advancing timestamps instead of the ad when nothing is ad-free.
//
// - During ads the player gets the playlist of an ad-free backup session: the 360p bridge right
//   away, a full-quality player type once it looked ad-free twice (1.5 s apart).
// - Once the player's own session has been ad-free for 3 refreshes, it gets its own playlist
//   again (full quality, low latency).
// - Everything handed to the player is renumbered onto one timeline: segment numbers only go up,
//   a change of source is a discontinuity, aligned by EXT-X-PROGRAM-DATE-TIME so nothing repeats
//   or jumps. (Sessions number their segments differently; lower numbers make the player wait
//   forever - that is why the previous version stayed on the backup until the next reload.)
// - If no source is ad-free (a streamer's ad break reaches every player type), the ad segments
//   are cut out and replaced by black, silent 1.024 s segments ("hold"), and the page shows its
//   hint over the player. The playlist never runs empty: an empty playlist makes the player
//   re-request it many times a second and open new sessions, each starting with a new ad.
//   Streams in fMP4 / HEVC / AV1 get the ad passed on instead, covered and muted by the page
//   ('masked', twitch_main.js) - the hold segment is MPEG-TS/H.264.
(function () {
    'use strict';
    if (self.__abTwitchWorker) return;
    self.__abTwitchWorker = true;

    const INIT = __AB_WORKER_INIT__;
    const HOLD_TS = __AB_HOLD_SEGMENT__;  // base64: 1.024 s black + silence, MPEG-TS (H.264 + AAC)
    const LQ_TYPE = 'autoplay';           // 360p only, but quick and usually ad-free
    const TYPES = INIT.backupTypes || ['popout', 'frontpage', 'mobile_web', 'site', 'autoplay'];
    const HQ_TYPES = TYPES.filter(function (t) { return t !== LQ_TYPE; });
    const USE_LQ = TYPES.indexOf(LQ_TYPE) !== -1;
    const GQL_URL = 'https://gql.twitch.tv/gql';
    const GQL_QUERY = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature   authorization { isForbidden forbiddenReasonCode }   __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature   __typename  }}';
    const HOLD_URL = 'https://www.twitch.tv/__adblock_gx_hold.ts';
    const T = Object.assign({
        fetch: 3500,          // any single request
        search: 1500,         // longest a player request waits for the full-quality search
        proof: 1500,          // full-quality backup: second ad-free look at least this much later
        adCooldown: 15000,    // a backup that showed ads is asked again after this
        errorCooldown: 5000,  // ... after an error (doubles per error, up to 60 s)
        forbidden: 300000,    // ... when Twitch refuses the player type / codec does not match
        stalled: 10000,       // ... when the page reports the video stuck on it
        hqDwell: 8000,        // on the 360p bridge at least this long before searching full quality
        nativeClean: 3        // own session ad-free for this many new playlists -> back to it
    }, INIT.timing || {});
    const AD_TEXT = /stitched-ad|X-TV-TWITCH-AD|\/adsquared\/|SCTE35-OUT|EXT-X-CUE-OUT|CLASS="twitch-(?:stitched-)?ad(?:-|")|"MIDROLL"/i;
    const AD_SPOOFING_ENABLED = INIT.adSpoofing === true;  // setting, off by default
    const GQL_EVENT_HASH = '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b';
    const spoofedAdIds = new Set();
    const recentSpoofedAdIds = new Map(); // adId -> timestamp, capped at 50

    const realFetch = self.fetch.bind(self);
    const contexts = new Map();      // 'live:<login>' | 'vod:<id>' -> playback context
    const variantIndex = new Map();  // player's media playlist URL -> {ctx, want}
    const tokens = new Map();        // ctx key|type -> {value, signature, until}
    const relayed = new Map();       // relay request id -> resolve
    const seenAdIds = new Set();     // stitched-ad ids already counted for the statistics
    const viewer = Object.assign({}, INIT.viewer || {});  // headers of Twitch's own GQL requests
    if (INIT.authHeader && !viewer.Authorization) viewer.Authorization = INIT.authHeader;
    if (INIT.deviceId && !viewer['X-Device-Id']) {
        viewer['Device-ID'] = INIT.deviceId;
        viewer['X-Device-Id'] = INIT.deviceId;
    }
    let pageIsVod = !!INIT.vod;
    let sessionSeq = 0;
    let fallbackMasked = false;

    let channel = null;
    try { channel = new BroadcastChannel(INIT.channel); } catch (e) {}
    if (channel) {
        channel.addEventListener('message', function (e) {
            const d = e.data || {};
            if (d.event === 'viewer') Object.assign(viewer, d.headers || {});
            else if (d.event === 'page') pageIsVod = !!d.vod;
            else if (d.event === 'fetch-response' && relayed.has(d.id)) relayed.get(d.id)(d);
            else if (d.event === 'stalled') onStalled();
        });
    }

    function report(event, extra) {
        if (channel) {
            try { channel.postMessage(Object.assign({event: event}, extra || {})); } catch (e) {}
        }
    }

    function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    function withTimeout(promise, ms) {
        return Promise.race([promise, sleep(ms || T.fetch).then(function () { throw new Error('timeout'); })]);
    }

    function within(promise, ms) {
        return Promise.race([promise, sleep(ms).then(function () { return null; })]);
    }

    async function fetchText(url, init) {
        const r = await withTimeout(realFetch(url, init));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
    }

    // ---- playlist parsing ----
    const ATTR_REGEX = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    function parseAttrs(str) {
        const result = {};
        ATTR_REGEX.lastIndex = 0;
        let match = ATTR_REGEX.exec(str);
        while (match !== null) {
            let val = match[2];
            if (val && val.charCodeAt(0) === 34 && val.charCodeAt(val.length - 1) === 34) {
                val = val.slice(1, -1);
            }
            result[match[1].toUpperCase()] = val;
            match = ATTR_REGEX.exec(str);
        }
        return result;
    }

    function attr(line, name) {
        const m = line.match(new RegExp('[:,]' + name + '=("[^"]*"|[^,]*)'));
        return m ? m[1].replace(/^"|"$/g, '') : '';
    }

    function absolute(uri, base) {
        if (!base || /^[a-z][a-z0-9+.-]*:/i.test(uri)) return uri;
        try { return new URL(uri, base).href; } catch (e) { return uri; }
    }

    function absoluteTag(line, base) {
        return line.replace(/URI="([^"]+)"/, function (_, u) { return 'URI="' + absolute(u, base) + '"'; });
    }

    function isAdTitle(extinf) {
        const i = extinf.indexOf(',');
        const title = i < 0 ? '' : extinf.slice(i + 1).trim();
        return title !== '' && title !== 'live';
    }

    function isAdUri(uri) {
        return /stitched|\/adsquared\/|\/_404\//.test(uri);
    }

    function isAdMarker(line) {
        if (!line.startsWith('#EXT-X-DATERANGE')) return false;
        if (line.indexOf('stitched-ad') !== -1 || line.indexOf('X-TV-TWITCH-AD') !== -1) return true;
        // stream source "Amazon|..." instead of "live" drives the player's ad overlay
        const m = line.match(/X-TV-TWITCH-STREAM-SOURCE="([^"]*)"/);
        return !!m && m[1] !== 'live';
    }

    function isAdLine(line) {
        return line.charAt(0) === '#' && (AD_TEXT.test(line) || isAdMarker(line));
    }

    function hasAds(text) {
        if (AD_TEXT.test(text)) return true;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if ((line.startsWith('#EXTINF:') && isAdTitle(line)) || isAdMarker(line)) return true;
            if (line && line.charAt(0) !== '#' && isAdUri(line)) return true;
        }
        return false;
    }

    // When does the ad pod end? (START-DATE + DURATION of the stitched-ad DATERANGE tags)
    function adEndsAt(text) {
        let end = 0;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.startsWith('#EXT-X-DATERANGE') || line.indexOf('stitched-ad') === -1) continue;
            const start = Date.parse((line.match(/START-DATE="([^"]+)"/) || [])[1] || '');
            const dur = parseFloat((line.match(/[,:]DURATION=([\d.]+)/) || [])[1] ||
                                   (line.match(/AD-POD-FILLED-DURATION="([\d.]+)"/) || [])[1] || 'NaN');
            if (isFinite(start) && isFinite(dur)) end = Math.max(end, start + dur * 1000);
        }
        return end || null;
    }

    // ---- ad spoofing (TTV-AB technique, only if switched on): report ad impressions & quartiles to Twitch GQL ----
    async function notifyAdComplete(text) {
        if (!AD_SPOOFING_ENABLED || !text || typeof text !== 'string') return;
        const lines = text.split('\n');
        const adLines = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXT-X-DATERANGE') && (line.indexOf('stitched-ad') !== -1 || line.indexOf('twitch-stitched-ad') !== -1)) {
                adLines.push(line);
            }
        }
        if (!adLines.length) return;

        const podLenMatch = text.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
        const explicitPodLength = podLenMatch ? parseInt(podLenMatch[1], 10) : 0;
        const hasExplicitPodLength = explicitPodLength > 0;
        const podLength = hasExplicitPodLength ? explicitPodLength : adLines.length;

        if (hasExplicitPodLength && spoofedAdIds.size >= podLength) return;

        for (let i = 0; i < adLines.length; i++) {
            if (hasExplicitPodLength && spoofedAdIds.size >= podLength) break;
            const line = adLines[i];
            const attr = parseAttrs(line);
            const idMatch = line.match(/\bID="([^"]+)"/);
            const stitchedAdId = (idMatch && idMatch[1]) || attr['ID'] || '';
            if (!stitchedAdId) continue;

            if (recentSpoofedAdIds.has(stitchedAdId)) {
                spoofedAdIds.add(stitchedAdId);
                continue;
            }
            if (spoofedAdIds.has(stitchedAdId)) continue;

            const radToken = attr['X-TV-TWITCH-AD-RADS-TOKEN'];
            if (!radToken) continue;

            const rollType = (attr['X-TV-TWITCH-AD-ROLL-TYPE'] || '').toLowerCase();
            const adPos = parseInt(attr['X-TV-TWITCH-AD-POD-POSITION'] || String(i), 10) || 0;
            const dur = parseFloat(attr['X-TV-TWITCH-AD-DURATION'] || attr['DURATION'] || attr['X-TV-TWITCH-AD-POD-FILLED-DURATION'] || '0') || 0;
            const adDuration = Math.round(dur);

            const payload = {
                stitched: true,
                ad_id: stitchedAdId,
                roll_type: rollType,
                creative_id: attr['X-TV-TWITCH-AD-CREATIVE-ID'] || '',
                order_id: attr['X-TV-TWITCH-AD-ORDER-ID'] || '',
                line_item_id: attr['X-TV-TWITCH-AD-LINE-ITEM-ID'] || '',
                player_mute: false,
                player_volume: 1.0,
                visible: true,
                duration: adDuration,
                ad_position: adPos,
                total_ads: podLength,
            };

            const makePacket = function (eventName, extra) {
                return {
                    operationName: 'ClientSideAdEventHandling_RecordAdEvent',
                    variables: {
                        input: {
                            eventName: eventName,
                            eventPayload: JSON.stringify(Object.assign({}, payload, extra || {})),
                            radToken: radToken,
                        },
                    },
                    extensions: {
                        persistedQuery: {
                            version: 1,
                            sha256Hash: GQL_EVENT_HASH,
                        },
                    },
                };
            };

            spoofedAdIds.add(stitchedAdId);
            recentSpoofedAdIds.set(stitchedAdId, Date.now());
            while (recentSpoofedAdIds.size > 50) {
                const oldest = recentSpoofedAdIds.keys().next().value;
                if (oldest === undefined) break;
                recentSpoofedAdIds.delete(oldest);
            }

            const batch = [
                makePacket('video_ad_impression'),
                makePacket('video_ad_quartile_complete', { quartile: 1 }),
                makePacket('video_ad_quartile_complete', { quartile: 2 }),
                makePacket('video_ad_quartile_complete', { quartile: 3 }),
                makePacket('video_ad_quartile_complete', { quartile: 4 }),
            ];
            if (hasExplicitPodLength && spoofedAdIds.size >= podLength) {
                batch.push(makePacket('video_ad_pod_complete'));
            }

            const headers = gqlHeaders(true);
            if (!headers['X-Device-Id']) {
                headers['X-Device-Id'] = headers['Device-ID'] || INIT.deviceId || 'oauth';
            }

            try {
                realFetch(GQL_URL, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(batch),
                }).then(function (response) {
                    if (response && response.status !== 200) {
                        report('error', {error: 'Ad spoofing GQL status ' + response.status});
                    }
                }).catch(function (err) {
                    report('error', {error: 'Ad spoofing failed: ' + (err && err.message || err)});
                });
            } catch (err) {
                report('error', {error: 'Ad spoofing sync error: ' + (err && err.message || err)});
            }

            report('ad-spoofed', {count: 1, id: stitchedAdId, roll: rollType});
        }
    }

    // seconds of ads seen (each stitched ad once) - for the statistics
    function countAdSeconds(text) {
        const re = /#EXT-X-DATERANGE:[^\n]*ID="(stitched-ad-[^"]{1,200})"[^\n]*/g;
        let m, seconds = 0;
        while ((m = re.exec(text))) {
            if (seenAdIds.has(m[1])) continue;
            seenAdIds.add(m[1]);
            const d = parseFloat((m[0].match(/[,:]DURATION=([\d.]+)/) || [])[1] ||
                                 (m[0].match(/X-TV-TWITCH-AD-DURATION="([\d.]+)"/) || [])[1] || '0');
            if (d > 0 && d < 600) seconds += d;
        }
        if (seenAdIds.size > 500) seenAdIds.clear();
        if (seconds) report('ad-seconds', {seconds: Math.round(seconds)});
    }

    function codecFamily(codecs) {
        const c = (codecs || '').toLowerCase();
        if (/(^|,)\s*(hev1|hvc1)/.test(c)) return 'hevc';
        if (/(^|,)\s*av01/.test(c)) return 'av1';
        if (/(^|,)\s*avc[13]/.test(c)) return 'avc';
        return '';
    }

    function parseVariants(master, base) {
        const lines = master.split(/\r?\n/);
        const list = [];
        for (let i = 0; i < lines.length - 1; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
            const uri = lines[i + 1].trim();
            if (!uri || uri.startsWith('#')) continue;
            const res = attr(lines[i], 'RESOLUTION');
            list.push({uri: absolute(uri, base), raw: uri, res: res,
                       fps: parseFloat(attr(lines[i], 'FRAME-RATE')) || 0,
                       height: parseInt(res.split('x')[1] || '0', 10),
                       family: codecFamily(attr(lines[i], 'CODECS')),
                       name: attr(lines[i], 'IVS-NAME') || attr(lines[i], 'STABLE-VARIANT-ID')});
        }
        return list;
    }

    // The backup variant for what the player plays: same codec family (a codec change mid-stream
    // breaks the decoder), then same name / resolution / frame rate, else the best one below.
    function pickVariant(list, want) {
        let pool = list;
        if (want.family) {
            pool = list.filter(function (v) { return !v.family || v.family === want.family; });
            if (!pool.length) return null;
        }
        if (want.name) {
            const named = pool.filter(function (v) { return v.name === want.name; });
            if (named.length) return named[0];
        }
        const exact = pool.filter(function (v) { return v.res && v.res === want.res; });
        if (exact.length) {
            exact.sort(function (a, b) { return Math.abs(a.fps - want.fps) - Math.abs(b.fps - want.fps); });
            return exact[0];
        }
        const lower = pool.filter(function (v) { return v.height <= want.height; });
        const sorted = (lower.length ? lower : pool).slice().sort(function (a, b) { return b.height - a.height || b.fps - a.fps; });
        return sorted[0] || null;
    }

    // Media playlist -> {header, segs, tail, ended}. A segment keeps the EXT-X-MAP / EXT-X-KEY in
    // effect for it, its discontinuity number (as players count them) and its start time (PDT).
    const SEG_TAG = /^#EXT(INF|-X-(DISCONTINUITY$|PROGRAM-DATE-TIME|MAP|KEY|BYTERANGE|GAP|TWITCH-PREFETCH|PART|PRELOAD-HINT))/;

    function parseMedia(text, base) {
        const lines = text.split(/\r?\n/);
        let lastUri = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i].trim();
            if (l && l.charAt(0) !== '#') { lastUri = i; break; }
        }
        const p = {header: [], segs: [], tail: [], ended: false, text: text};
        let seq = 0, ds = 0, inHeader = true, tags = [], disc = false, map = null, key = null;
        let pdt = null, nextPdt = null, extinf = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line === '#EXT-X-ENDLIST') { p.ended = true; continue; }
            if (inHeader) {
                if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                    seq = parseInt(line.slice(22), 10) || 0;
                    p.header.push('#EXT-X-MEDIA-SEQUENCE:');  // filled in by render()
                    continue;
                }
                if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) { ds = parseInt(line.slice(30), 10) || 0; continue; }
                if (line.charAt(0) === '#' && !SEG_TAG.test(line)) { p.header.push(line); continue; }
                inHeader = false;
            }
            if (lastUri >= 0 && i > lastUri) { p.tail.push(line); continue; }  // prefetch hints etc.
            if (line === '#EXT-X-DISCONTINUITY') {
                disc = true;
                map = null;  // Twitch: fMP4 ads inside MPEG-TS streams - an ad's MAP must not stick to live segments
                continue;
            }
            if (line.startsWith('#EXT-X-MAP:')) { map = absoluteTag(line, base); continue; }
            if (line.startsWith('#EXT-X-KEY:')) { key = /METHOD=NONE/.test(line) ? null : absoluteTag(line, base); continue; }
            if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                const t = Date.parse(line.slice(25));
                if (isFinite(t)) pdt = t;
                tags.push(line);
                continue;
            }
            if (line.startsWith('#EXTINF:')) extinf = line;
            if (line.charAt(0) === '#') { tags.push(line); continue; }
            const dur = extinf ? parseFloat(extinf.slice(8)) || 0 : 0;
            const uri = absolute(line, base);
            const start = pdt !== null ? pdt : nextPdt;
            if (disc) ds++;
            p.segs.push({seq: seq, ds: ds, disc: disc, map: map, key: key, tags: tags, uri: uri, dur: dur, pdt: start,
                         ad: (!!extinf && isAdTitle(extinf)) || isAdUri(uri)});
            seq++;
            nextPdt = start !== null ? start + dur * 1000 : null;
            tags = [];
            disc = false;
            pdt = null;
            extinf = null;
        }
        return p;
    }

    function keyLine(e) {
        if (!e.key) return null;
        if (e.out === e.seq || /[:,]IV=/.test(e.key)) return e.key;
        // AES-128 without IV uses the segment number as IV: keep the original one
        let hex = e.seq.toString(16);
        while (hex.length < 32) hex = '0' + hex;
        return e.key + ',IV=0x' + hex;
    }

    function render(header, entries, tail) {
        const first = entries[0];
        const ds = Math.max(0, first.ds - (first.disc ? 1 : 0));
        const seqLines = ['#EXT-X-MEDIA-SEQUENCE:' + first.out];
        if (ds > 0) seqLines.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + ds);
        const out = header[0] === '#EXTM3U' ? [] : ['#EXTM3U'];
        let seqWritten = false;
        header.forEach(function (l) {
            if (l === '#EXT-X-MEDIA-SEQUENCE:') {
                if (!seqWritten) out.push.apply(out, seqLines);
                seqWritten = true;
            } else {
                out.push(l);
            }
        });
        if (!seqWritten) out.splice.apply(out, [1, 0].concat(seqLines));
        let map = null, key = null;
        entries.forEach(function (e) {
            if (e.disc) out.push('#EXT-X-DISCONTINUITY');
            if (e.map && e.map !== map) out.push(e.map);
            map = e.map;
            const k = keyLine(e);
            if (k !== key) {
                if (k || key) out.push(k || '#EXT-X-KEY:METHOD=NONE');
                key = k;
            }
            out.push.apply(out, e.tags);
            out.push(e.uri);
        });
        out.push.apply(out, tail);
        return out.join('\n') + '\n';
    }

    // ---- one timeline for everything the player gets ----
    function newTimeline(source) {
        return {source: source, switched: false, epoch: 0, offset: 0, dsShift: 0, boundary: -Infinity,
                lastOut: -1, lastDs: 0, lastEnd: 0, lastHoldAt: 0, holdSeq: 0, hist: new Map()};
    }

    // The first segment of `segs` the player does not have yet (by time), or null if there is none.
    function align(tl, segs) {
        if (tl.lastOut < 0) return segs[0] || null;
        if (tl.lastEnd && segs.some(function (s) { return s.pdt !== null; })) {
            return segs.find(function (s) { return s.pdt !== null && s.pdt >= tl.lastEnd - 500; }) || null;
        }
        return segs[segs.length - 1] || null;
    }

    // Continue the player's timeline with source `id`: its next new segment gets the next number,
    // behind a discontinuity. false: the source has nothing newer yet (and `force` is not set).
    function switchTo(tl, id, segs, force) {
        let cand = align(tl, segs);
        if (!cand) {
            if (!force || !segs.length) return false;
            cand = segs[segs.length - 1];
        }
        tl.epoch++;
        tl.source = id;
        tl.lastHoldAt = 0;
        if (tl.lastOut < 0) {
            tl.offset = 0;
            tl.dsShift = 0;
            tl.boundary = -Infinity;
        } else {
            tl.boundary = tl.lastOut + 1;
            tl.offset = tl.boundary - cand.seq;
            tl.dsShift = tl.lastDs + 1 - cand.ds;
            tl.switched = true;
        }
        return true;
    }

    // Without the ads: the live segments after the ad (ad over) or before it (ad running) - one
    // contiguous run, as segment numbers are implicit in HLS.
    function liveRun(segs) {
        let firstAd = -1, lastAd = -1;
        segs.forEach(function (s, i) {
            if (!s.ad) return;
            if (firstAd < 0) firstAd = i;
            lastAd = i;
        });
        if (lastAd < 0) return segs;
        return lastAd < segs.length - 1 ? segs.slice(lastAd + 1) : segs.slice(0, firstAd);
    }

    // The playlist for the player's request `url` from source `id` (null: source not usable yet).
    // strip: leave out ad segments and ad tags. force: switch even if the source has nothing newer.
    function serve(ctx, url, id, src, opts) {
        opts = opts || {};
        const tl = ctx.tl;
        const segs = opts.strip ? liveRun(src.segs) : src.segs;
        if (!segs.length) return null;
        if (tl.source !== id) {
            // a source that stays behind for long is taken anyway (a few seconds repeat)
            const waited = ctx.wait && ctx.wait.id === id && Date.now() - ctx.wait.since > 6000;
            if (!switchTo(tl, id, segs, opts.force || waited)) {
                if (!ctx.wait || ctx.wait.id !== id) ctx.wait = {id: id, since: Date.now()};
                return null;
            }
            ctx.wait = null;
        } else if (tl.switched && tl.lastOut >= 0) {
            // same source, but cut-out ads leave a gap in the numbering: continue behind a discontinuity
            const next = segs.find(function (s) { return s.seq + tl.offset > tl.lastOut; });
            if (next && next.seq + tl.offset > tl.lastOut + 1) switchTo(tl, id, segs, true);
        }
        const verbatim = !tl.switched && id === ctx.nativeId && !opts.strip;
        return emit(ctx, url, src, segs, !!opts.strip, verbatim ? src.text : null);
    }

    function emit(ctx, url, src, segs, strip, verbatim) {
        const tl = ctx.tl;
        const cur = [];
        segs.forEach(function (s) {
            const out = s.seq + tl.offset;
            if (out < tl.boundary) return;
            cur.push({out: out, ds: s.ds + tl.dsShift, disc: s.disc || out === tl.boundary, map: s.map, key: s.key,
                      seq: s.seq, tags: strip ? s.tags.filter(function (l) { return !isAdLine(l); }) : s.tags,
                      uri: s.uri, dur: s.dur, pdt: s.pdt, ad: s.ad, epoch: tl.epoch});
        });
        const hist = tl.hist.get(url) || [];
        let entries = hist;
        if (cur.length) {
            // keep the end of what the player got from the previous source, so the change is seamless
            const prev = [];
            for (let i = hist.length - 1; i >= 0; i--) {
                const e = hist[i];
                if (e.epoch === tl.epoch) continue;
                if (e.ad || e.out !== (prev.length ? prev[0].out : cur[0].out) - 1) break;
                prev.unshift(e);
            }
            const room = Math.max(src.segs.length, 4) - cur.length;
            entries = (room > 0 ? prev.slice(-room) : []).concat(cur);
        }
        if (!entries.length) return null;
        tl.hist.set(url, entries);
        const last = entries[entries.length - 1];
        if (last.out > tl.lastOut) {
            tl.lastOut = last.out;
            tl.lastDs = last.ds;
        }
        if (last.pdt !== null) tl.lastEnd = Math.max(tl.lastEnd, last.pdt + last.dur * 1000);
        if (verbatim) return verbatim;
        const header = strip ? src.header.filter(function (l) { return !isAdLine(l); }) : src.header;
        return render(header, entries, cur.length && !strip ? src.tail : []);
    }

    // Black, silent segments instead of the ad - as many as real time has passed, so the player's
    // buffer neither runs dry nor grows. The ad's time is skipped: afterwards the stream continues live.
    function hold(ctx, url, src) {
        const tl = ctx.tl;
        const now = Date.now();
        if (tl.lastOut < 0) {
            tl.lastOut = src.segs[0].seq - 1;
            tl.lastDs = src.segs[0].ds;
        }
        const count = tl.lastHoldAt ? Math.min(3, Math.max(1, Math.round((now - tl.lastHoldAt) / 1024))) : 2;
        tl.lastHoldAt = now;
        tl.epoch++;
        const entries = [];
        for (let i = 0; i < count; i++) {
            tl.holdSeq++;
            tl.lastOut++;
            tl.lastDs++;
            entries.push({out: tl.lastOut, ds: tl.lastDs, disc: true, map: null, key: null, seq: tl.lastOut,
                          tags: ['#EXTINF:1.024,live'], uri: HOLD_URL + '?n=' + tl.holdSeq, dur: 1.024, pdt: null,
                          ad: true, epoch: tl.epoch});
        }
        tl.source = 'hold';
        tl.switched = true;
        const last = src.segs[src.segs.length - 1];
        if (last.pdt !== null) tl.lastEnd = Math.max(tl.lastEnd, last.pdt + last.dur * 1000);
        tl.hist.set(url, entries);
        const td = Math.max(2, Math.ceil(parseFloat((src.header.find(function (l) {
            return l.startsWith('#EXT-X-TARGETDURATION:');
        }) || ':2').split(':')[1]) || 2));
        return render(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + td, '#EXT-X-MEDIA-SEQUENCE:'], entries, []);
    }

    // The hold segment with its timestamps moved on by n * 1.024 s (90 kHz clock, 33 bits).
    let holdBytes = null;
    function holdSegment(n) {
        if (!holdBytes) holdBytes = Uint8Array.from(atob(HOLD_TS), function (c) { return c.charCodeAt(0); });
        const b = holdBytes.slice();
        const shift = (n % 80000) * 92160;
        const WRAP = 8589934592;  // 2^33
        function moveTs(o) {
            let v = ((b[o] >> 1) & 7) * 1073741824 + b[o + 1] * 4194304 + (b[o + 2] >> 1) * 32768 +
                    b[o + 3] * 128 + (b[o + 4] >> 1);
            v = (v + shift) % WRAP;
            b[o] = (b[o] & 0xF1) | ((Math.floor(v / 1073741824) & 7) << 1);
            b[o + 1] = Math.floor(v / 4194304) & 0xFF;
            b[o + 2] = ((Math.floor(v / 32768) & 0x7F) << 1) | 1;
            b[o + 3] = Math.floor(v / 128) & 0xFF;
            b[o + 4] = ((v % 128) << 1) | 1;
        }
        function movePcr(o) {
            let v = b[o] * 33554432 + b[o + 1] * 131072 + b[o + 2] * 512 + b[o + 3] * 2 + (b[o + 4] >> 7);
            v = (v + shift) % WRAP;
            b[o] = Math.floor(v / 33554432) & 0xFF;
            b[o + 1] = Math.floor(v / 131072) & 0xFF;
            b[o + 2] = Math.floor(v / 512) & 0xFF;
            b[o + 3] = Math.floor(v / 2) & 0xFF;
            b[o + 4] = (b[o + 4] & 0x7F) | ((v % 2) << 7);
        }
        for (let i = 0; i + 188 <= b.length; i += 188) {
            if (b[i] !== 0x47) break;
            let p = i + 4;
            const afc = (b[i + 3] >> 4) & 3;
            if (afc & 2) {
                const len = b[p];
                if (len >= 7 && (b[p + 1] & 0x10)) movePcr(p + 2);
                p += 1 + len;
            }
            if (!(afc & 1) || !(b[i + 1] & 0x40)) continue;  // no payload / not the start of a PES packet
            if (p + 19 > i + 188 || b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
            const flags = b[p + 7] >> 6;
            if (flags & 2) moveTs(p + 9);
            if (flags === 3) moveTs(p + 14);
        }
        return b;
    }

    // ---- backup sessions ----
    function gqlHeaders(asViewer) {
        const h = {'Client-ID': INIT.clientId, 'Content-Type': 'text/plain;charset=UTF-8'};
        const device = viewer['X-Device-Id'] || INIT.deviceId;
        if (device) {
            h['Device-ID'] = device;
            h['X-Device-Id'] = device;
        }
        if (viewer['Client-Version']) h['Client-Version'] = viewer['Client-Version'];
        if (viewer['Client-Session-Id']) h['Client-Session-Id'] = viewer['Client-Session-Id'];
        if (asViewer) {
            if (viewer.Authorization) h.Authorization = viewer.Authorization;
            if (viewer['Client-Integrity']) h['Client-Integrity'] = viewer['Client-Integrity'];
        }
        return h;
    }

    // GQL through the page as a fallback: requests from the worker sometimes get "server error".
    function relayFetch(url, init) {
        if (!channel || INIT.relay === false) return Promise.resolve(null);
        const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2);
        return new Promise(function (resolve) {
            const timer = setTimeout(function () { relayed.delete(id); resolve(null); }, T.fetch);
            relayed.set(id, function (d) {
                clearTimeout(timer);
                relayed.delete(id);
                resolve(d.error ? null : new Response(d.body, {status: d.status || 200}));
            });
            report('fetch-request', {id: id, url: url, init: {method: init.method, headers: init.headers, body: init.body}});
        });
    }

    async function gql(body, asViewer) {
        const init = {method: 'POST', headers: gqlHeaders(asViewer), body: JSON.stringify(body)};
        let r = null, json = null;
        try {
            r = await withTimeout(realFetch(GQL_URL, init));
            if (r.ok) json = await r.json();
        } catch (e) {}
        if (!json || (json.errors && !json.data)) {
            const relay = await relayFetch(GQL_URL, init);
            if (relay && relay.ok) json = await relay.json();
        }
        if (!json) throw new Error(r ? 'GQL HTTP ' + r.status : 'GQL nicht erreichbar');
        return json;
    }

    function tokenUntil(value) {
        try {
            const exp = JSON.parse(value).expires;
            if (exp) return Math.min(exp * 1000 - 60000, Date.now() + 15 * 60000);
        } catch (e) {}
        return Date.now() + 5 * 60000;
    }

    async function getToken(ctx, type) {
        const key = ctx.key + '|' + type;
        const cached = tokens.get(key);
        if (cached && cached.until > Date.now()) return cached;
        const variables = {isLive: !ctx.vod, login: ctx.vod ? '' : ctx.login, isVod: !!ctx.vod, vodID: ctx.vod || '',
                           playerType: type, platform: type === LQ_TYPE ? 'android' : 'web'};
        let error = 'kein Token';
        // anonymous first; with the viewer's login only if Twitch refuses (e.g. sub-only streams)
        for (const asViewer of [false, true]) {
            if (asViewer && !viewer.Authorization) break;
            const j = await gql({operationName: 'PlaybackAccessToken_Template', query: GQL_QUERY, variables: variables}, asViewer);
            const t = j && j.data && (j.data.streamPlaybackAccessToken || j.data.videoPlaybackAccessToken);
            if (t && t.value && t.signature) {
                if (t.authorization && t.authorization.isForbidden) {
                    error = 'forbidden ' + (t.authorization.forbiddenReasonCode || '');
                    continue;
                }
                const token = {value: t.value, signature: t.signature, until: tokenUntil(t.value)};
                tokens.set(key, token);
                return token;
            }
            if (j && j.errors && j.errors.length) error = String(j.errors[0].message || error);
        }
        throw new Error(error);
    }

    function randomHex(n) {
        let s = '';
        for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    async function openSession(ctx, type, old) {
        const token = await getToken(ctx, type);
        const u = new URL(ctx.usher);  // the player's own request, so codecs, low latency etc. match
        u.searchParams.set('sig', token.signature);
        u.searchParams.set('token', token.value);
        u.searchParams.set('p', String(Math.floor(Math.random() * 1e7)));
        u.searchParams.set('play_session_id', randomHex(32));
        const master = await fetchText(u.href);
        const variants = parseVariants(master, u.href);
        if (!variants.length) throw new Error('keine Varianten');
        return {id: ++sessionSeq, type: type, variants: variants, retryAt: 0, errors: old ? old.errors : 0,
                cleanLooks: 0, firstClean: 0, lastLook: 0, trusted: false, last: old ? old.last : null, stalledAt: 0};
    }

    function note(ctx, s, result, extra) {
        if (s.last === result) return;  // only changes, not every 2 s
        s.last = result;
        report('backup-result', Object.assign({type: s.type, result: result}, extra || {}));
    }

    function proven(s) {
        return s.type === LQ_TYPE || s.trusted || (s.cleanLooks >= 2 && Date.now() - s.firstClean >= T.proof);
    }

    function fail(ctx, type, s, error, cooldown) {
        s = s || {id: 0, type: type, errors: 0, last: null};
        s.variants = null;
        s.errors = (s.errors || 0) + 1;
        s.cleanLooks = 0;
        s.retryAt = Date.now() + (cooldown || Math.min(60000, T.errorCooldown * Math.pow(2, s.errors - 1)));
        ctx.sessions.set(type, s);
        note(ctx, s, 'fehler', {error: error});
    }

    // The backup's playlist for the variant the player asked for (null: not usable right now).
    async function backupPlaylist(ctx, type, want, respectCooldown) {
        let s = ctx.sessions.get(type);
        const now = Date.now();
        if (s && s.stalledAt && now - s.stalledAt < T.stalled) return null;
        if (respectCooldown && s && s.retryAt > now) return null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const fresh = !s || !s.variants;
            try {
                if (fresh) {
                    s = await openSession(ctx, type, s);
                    ctx.sessions.set(type, s);
                }
                const v = pickVariant(s.variants, want);
                if (!v) {
                    fail(ctx, type, s, 'kein passender Codec (' + want.family + ')', T.forbidden);
                    return null;
                }
                const text = await fetchText(v.uri);
                const parsed = parseMedia(text, v.uri);
                if (!parsed.segs.length || parsed.ended) throw new Error('leere Playlist');
                const ads = hasAds(text);
                s.lastLook = Date.now();
                s.errors = 0;
                if (ads) {
                    s.cleanLooks = 0;
                    s.trusted = false;
                    s.retryAt = Date.now() + T.adCooldown;
                    note(ctx, s, 'werbung', {neu: fresh, endsAt: adEndsAt(text)});
                } else {
                    if (!s.cleanLooks) s.firstClean = s.lastLook;
                    s.cleanLooks++;
                    s.retryAt = 0;
                    note(ctx, s, 'frei', {neu: fresh});
                }
                return {type: type, id: type + ':' + s.id, session: s, parsed: parsed, text: text, ads: ads,
                        lq: type === LQ_TYPE, res: v.res, want: want, proven: !ads && proven(s)};
            } catch (e) {
                if (!fresh) {  // the old session expired: once more with a new one
                    s.variants = null;
                    continue;
                }
                const msg = String(e && e.message || e);
                fail(ctx, type, s, msg, /forbidden/i.test(msg) ? T.forbidden : 0);
                return null;
            }
        }
        return null;
    }

    // Second look at a full-quality backup that was ad-free before (null: none ready).
    async function provenHq(ctx, want, exclude) {
        const now = Date.now();
        const candidates = HQ_TYPES.map(function (t) { return ctx.sessions.get(t); }).filter(function (s) {
            return s && s.type !== exclude && s.variants && s.cleanLooks > 0 && s.retryAt <= now &&
                   (proven(s) || now - s.firstClean >= T.proof);
        }).sort(function (a, b) { return b.lastLook - a.lastLook; });
        if (!candidates.length) return null;
        const b = await backupPlaylist(ctx, candidates[0].type, want, true);
        return b && !b.ads && b.proven ? b : null;
    }

    // Look through the full-quality player types one after another (one search at a time).
    function searchHq(ctx, want, exclude) {
        if (ctx.scan) return ctx.scan;
        if (ctx.bridgeSince && Date.now() - ctx.bridgeSince < T.hqDwell) return Promise.resolve(null);
        const order = HQ_TYPES.filter(function (t) { return t !== exclude; });
        ctx.scan = (async function () {
            for (let i = 0; i < order.length; i++) {
                const b = await backupPlaylist(ctx, order[i], want, true);
                if (b && !b.ads) return b;
            }
            return null;
        })().catch(function () { return null; }).finally(function () { ctx.scan = null; });
        return ctx.scan;
    }

    function typeOf(source) {
        const i = source.indexOf(':');
        const type = i < 0 ? '' : source.slice(0, i);
        return type && type !== 'native' ? type : null;
    }

    function onStalled() {
        // the page sees the video stuck: put the backup in use aside, the next refresh takes another source
        contexts.forEach(function (ctx) {
            const type = ctx.tl && typeOf(ctx.tl.source);
            const s = type && ctx.sessions.get(type);
            if (s) {
                s.stalledAt = Date.now();
                s.trusted = false;
                note(ctx, s, 'haengt');
            }
        });
    }

    // ---- what the player gets ----
    function startAd(ctx, text) {
        countAdSeconds(text);
        notifyAdComplete(text).catch(function () {});
        if (ctx.inAd) return;
        ctx.inAd = true;
        ctx.sessions.forEach(function (s) { if (s.last === 'werbung') s.retryAt = 0; });  // new ad break: ask again
        report('ad-start', {playlist: text.slice(0, 15000), endsAt: adEndsAt(text)});  // kept for the ad log
    }

    function endAd(ctx) {
        unmask(ctx);
        if (!ctx.inAd) return;
        ctx.inAd = false;
        spoofedAdIds.clear();
        report('ad-end');
    }

    function mask(ctx, out, adText, isHold) {
        ctx.masked = true;
        report('masked', {endsAt: adEndsAt(adText), hold: !!isHold});
        return out;
    }

    function unmask(ctx) {
        if (!ctx.masked) return;
        ctx.masked = false;
        report('unmasked');
    }

    function setBridge(ctx, on) {
        if (!!ctx.bridgeSince === on) return;
        ctx.bridgeSince = on ? Date.now() : 0;
        report('bridge', {on: on});
    }

    function canHold(ctx, want) {
        return INIT.hold !== false && !ctx.vod && want.family !== 'hevc' && want.family !== 'av1' && ctx.fmp4 !== true;
    }

    function trackNative(ctx, nat, ads) {
        const lastSeq = nat.segs[nat.segs.length - 1].seq;
        if (ads) {
            ctx.cleanStreak = 0;
        } else {
            if (ctx.natLastSeq === null || lastSeq > ctx.natLastSeq) ctx.cleanStreak++;  // only new playlists count
            ctx.fmp4 = nat.segs.some(function (s) { return !!s.map; });
        }
        ctx.natLastSeq = lastSeq;
    }

    async function processLive(ctx, url, want, text) {
        const tl = ctx.tl;
        const nat = parseMedia(text, url);
        if (!nat.segs.length || nat.ended) return text;
        const natAds = hasAds(text);
        trackNative(ctx, nat, natAds);
        const nid = ctx.nativeId;

        // the player's own session, whenever it is (again) ad-free
        if (!natAds && (tl.source === nid || ctx.cleanStreak >= T.nativeClean)) {
            const wasBackup = typeOf(tl.source);
            const out = serve(ctx, url, nid, nat);
            if (out) {
                if (wasBackup) report('native-back', {from: wasBackup});
                setBridge(ctx, false);
                endAd(ctx);
                return out;
            }
        }
        if (natAds) startAd(ctx, text);

        // the backup in use
        const curType = typeOf(tl.source);
        const cur = curType ? await backupPlaylist(ctx, curType, want, false) : null;
        const curOk = !!cur && !cur.ads;
        if (!curOk && !natAds) {
            // backup gone or with ads, own session ad-free: back to it
            const out = serve(ctx, url, nid, nat, {force: true});
            if (out) {
                if (curType) report('native-back', {from: curType});
                setBridge(ctx, false);
                endAd(ctx);
                return out;
            }
        }

        // otherwise / better: the 360p bridge right away, full quality once it proved ad-free
        let lqP = null, hq = null;
        if (!curOk && USE_LQ && curType !== LQ_TYPE) lqP = backupPlaylist(ctx, LQ_TYPE, want, true);
        if (!curOk || cur.lq) {
            hq = await provenHq(ctx, want, curType);
            if (!hq) {
                const scan = searchHq(ctx, want, curType);
                hq = curOk ? null : await within(scan, T.search);  // wait only if nothing ad-free is playing
                if (hq && hq.want !== want) hq = await backupPlaylist(ctx, hq.type, want, true);
                if (hq && hq.ads) hq = null;
            }
        }
        const lq = lqP ? await lqP : null;
        const picks = [];
        if (curOk && !cur.lq) picks.push(cur);
        if (hq && hq.proven) picks.push(hq);
        if (curOk) picks.push(cur);
        if (lq && !lq.ads) picks.push(lq);
        if (hq) picks.push(hq);
        for (let i = 0; i < picks.length; i++) {
            const b = picks[i];
            const before = ctx.tl.source;
            const out = serve(ctx, url, b.id, b.parsed);
            if (!out) continue;  // nothing newer than what the player has yet
            if (before !== b.id) {
                report('backup', {type: b.type, res: b.res, lq: b.lq});
                if (!typeOf(before)) report('replaced', {type: b.type});
            }
            b.session.trusted = true;
            setBridge(ctx, b.lq);
            unmask(ctx);
            return out;
        }

        // nothing ad-free
        setBridge(ctx, false);
        if (canHold(ctx, want)) {
            // live segments of the player's playlist that are new, else black hold segments
            const tl2 = ctx.tl;
            const fresh = liveRun(nat.segs).some(function (s) {
                return tl2.lastOut < 0 || (tl2.source === nid ? s.seq + tl2.offset > tl2.lastOut
                                                               : s.pdt !== null && s.pdt >= tl2.lastEnd - 500);
            });
            const live = fresh && serve(ctx, url, nid, nat, {strip: true});
            if (live) {
                unmask(ctx);  // the ad is over, only its tags are still in Twitch's window
                return live;
            }
            return mask(ctx, hold(ctx, url, nat), text, true);
        }
        // stay with what the player has and let the page cover the ad
        if (cur) {
            const out = serve(ctx, url, cur.id, cur.parsed);
            if (out) return mask(ctx, out, cur.text, false);
        }
        return mask(ctx, serve(ctx, url, nid, nat, {force: true}) || text, text, false);
    }

    // VODs: the playlist is complete, ad segments are simply left out.
    function processVod(url, text) {
        if (!hasAds(text)) return text;
        const p = parseMedia(text, url);
        const keep = p.segs.filter(function (s) { return !s.ad; });
        if (!keep.length || keep.length === p.segs.length) return text;
        const first = p.segs[0].seq;
        const entries = keep.map(function (s, i) {
            return Object.assign({}, s, {out: first + i, tags: s.tags.filter(function (l) { return !isAdLine(l); })});
        });
        report('vod-stripped', {segments: p.segs.length - keep.length});
        return render(p.header.filter(function (l) { return !isAdLine(l); }), entries, p.ended ? ['#EXT-X-ENDLIST'] : []);
    }

    function lookupVariant(url) {
        const v = variantIndex.get(url);
        if (v || url.indexOf('_HLS_') === -1) return v;
        return variantIndex.get(url.replace(/([?&])_HLS_[a-z]+=[^&]*&?/gi, '$1').replace(/[?&]$/, ''));
    }

    async function processMediaPlaylist(url, text) {
        if (hasAds(text)) notifyAdComplete(text).catch(function () {});
        const v = lookupVariant(url);
        if (v && v.ctx.vod) return processVod(url, text);
        if (v) return processLive(v.ctx, url, v.want, text);
        // a playlist that was not in a master playlist we saw (should not happen): only cover ads
        if (!hasAds(text)) {
            if (fallbackMasked) report('unmasked');
            fallbackMasked = false;
            return text;
        }
        report('backup-result', {type: '-', result: 'fehler', error: 'Playlist nicht in der Master-Liste'});
        fallbackMasked = true;
        report('masked', {endsAt: adEndsAt(text)});
        return text;
    }

    function usherContext(url) {
        if (url.indexOf('usher.ttvnw.net/') === -1) return null;
        let m = url.match(/\/channel\/hls\/([^/.?]+)\.m3u8/);
        if (m) {
            const login = decodeURIComponent(m[1]).toLowerCase();
            return {key: 'live:' + login, login: login, vod: null};
        }
        m = url.match(/\/vod\/(?:v2\/)?(\d+)\.m3u8/);
        return m ? {key: 'vod:' + m[1], login: null, vod: m[1]} : null;
    }

    function registerMaster(u, url, text) {
        let ctx = contexts.get(u.key);
        if (!ctx) {
            ctx = {key: u.key, login: u.login, vod: u.vod, sessions: new Map(), gen: 0, tl: null, inAd: false,
                   masked: false, bridgeSince: 0, scan: null, cleanStreak: 0, natLastSeq: null, fmp4: undefined,
                   wait: null};
            contexts.set(u.key, ctx);
        }
        ctx.usher = url;
        ctx.gen++;
        ctx.nativeId = 'native:' + ctx.gen;
        ctx.natLastSeq = null;
        // a new session of the player's own: numbered anew. If the player was already on our timeline,
        // the timeline continues (its own segments get aligned like any other source).
        if (!ctx.tl || !ctx.tl.switched) ctx.tl = newTimeline(ctx.nativeId);
        parseVariants(text, url).forEach(function (v) {
            variantIndex.set(v.uri, {ctx: ctx, want: v});
            if (v.raw !== v.uri) variantIndex.set(v.raw, {ctx: ctx, want: v});
        });
        while (variantIndex.size > 400) variantIndex.delete(variantIndex.keys().next().value);
    }

    // VOD ads come as separate VAST requests (client-side ads)
    function isVodAdRequest(url, init) {
        const method = (init && init.method || 'GET').toUpperCase();
        return method === 'GET' &&
               /^https:\/\/(edge\.ads\.twitch\.tv|vaes\.amazon-adsystem\.com)\/(2018-01-01\/3p\/ads|ads\/format|ads)(?=[/?]|$)/.test(url);
    }

    self.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (url.indexOf(HOLD_URL) === 0) {
            const n = parseInt((url.match(/[?&]n=(\d+)/) || [])[1] || '1', 10);
            return new Response(holdSegment(n), {status: 200, headers: {'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store'}});
        }
        if (pageIsVod && isVodAdRequest(url, input && input.method ? input : init)) {
            report('vod-ad-blocked');
            return new Response(null, {status: 204});
        }
        const usher = usherContext(url);
        const isMedia = !usher && (url.indexOf('.ttvnw.net/v1/playlist/') !== -1 || !!lookupVariant(url));
        if (!usher && !isMedia) return realFetch(input, init);

        report(usher ? 'seen-master' : 'seen-playlist');
        const resp = await realFetch(input, init);
        if (!resp.ok) return resp;
        const text = await resp.text();
        let out = text;
        try {
            if (usher) registerMaster(usher, url, text);
            else out = await processMediaPlaylist(url, text);
        } catch (e) {
            report('error', {error: String(e && e.message || e)});
        }
        return new Response(out, {status: resp.status, statusText: resp.statusText, headers: resp.headers});
    };

    // exposed for tests only
    self.__abTwitchTest = {
        hasAds: hasAds,
        adEndsAt: adEndsAt,
        parseVariants: parseVariants,
        pickVariant: pickVariant,
        parseMedia: parseMedia,
        render: render,
        holdSegment: holdSegment,
        contexts: contexts,
        parseAttrs: parseAttrs,
        notifyAdComplete: notifyAdComplete,
        spoofedAdIds: spoofedAdIds,
        recentSpoofedAdIds: recentSpoofedAdIds
    };
    report('worker-hooked');
})();
