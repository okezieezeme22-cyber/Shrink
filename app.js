(function(){
  "use strict";

  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- theme toggle (per-viewer convenience only) ----------
  var themeBtn = document.getElementById("themeToggle");
  try {
    var savedTheme = localStorage.getItem("shrink-theme");
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  } catch (e) {}
  themeBtn.addEventListener("click", function(){
    var current = document.documentElement.getAttribute("data-theme");
    var next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("shrink-theme", next); } catch (e) {}
  });

  // ---------- helpers ----------
  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    var units = ["KB","MB","GB"];
    var val = bytes;
    var i = -1;
    do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
    return val.toFixed(val < 10 ? 2 : 1) + " " + units[i];
  }

  function animateNumber(el, from, to, formatFn) {
    if (reduceMotion || from === to) { el.textContent = formatFn(to); return; }
    var start = null;
    var duration = 500;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      var current = Math.round(from + (to - from) * eased);
      el.textContent = formatFn(current);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ---------- compression ----------
  async function compressImage(file, opts) {
    var bitmap = await createImageBitmap(file);
    var width = bitmap.width, height = bitmap.height;
    if (opts.maxWidth && width > opts.maxWidth) {
      var ratio = opts.maxWidth / width;
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    var outType = (file.type === "image/png" || file.type === "image/webp") ? "image/webp" : "image/jpeg";
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    if (outType === "image/jpeg") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (bitmap.close) bitmap.close();

    var blob = await new Promise(function(res){ canvas.toBlob(res, outType, opts.quality); });
    if (!blob) {
      // fallback if webp encode isn't supported
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await new Promise(function(res){ canvas.toBlob(res, "image/jpeg", opts.quality); });
    }
    return blob;
  }

  async function compressPdf(file, opts, onProgress) {
    var buffer = await file.arrayBuffer();
    var pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    var PDFDocument = PDFLib.PDFDocument;
    var out = await PDFDocument.create();

    for (var i = 1; i <= pdf.numPages; i++) {
      var page = await pdf.getPage(i);
      var viewport = page.getViewport({ scale: opts.scale });
      var canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      var dataUrl = canvas.toDataURL("image/jpeg", opts.quality);
      var jpegBytes = await (await fetch(dataUrl)).arrayBuffer();
      var jpegImage = await out.embedJpg(jpegBytes);
      var newPage = out.addPage([canvas.width, canvas.height]);
      newPage.drawImage(jpegImage, { x: 0, y: 0, width: canvas.width, height: canvas.height });

      if (onProgress) onProgress(i, pdf.numPages);
      canvas.width = canvas.height = 0;
    }

    var bytes = await out.save();
    // Rendering pages to pictures can make text PDFs bigger; keep the original then.
    if (bytes.length >= file.size) return file;
    return new Blob([bytes], { type: "application/pdf" });
  }

  // ---------- document compression (docx / xlsx / pptx / odt / ods / odp) ----------
  async function compressDocImage(blob, isJpeg, opts, originalLength) {
    var bitmap = await createImageBitmap(blob);
    var w = bitmap.width, h = bitmap.height;
    if (opts.maxWidth && w > opts.maxWidth) {
      var r = opts.maxWidth / w;
      w = Math.round(w * r);
      h = Math.round(h * r);
    }
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    if (isJpeg) {
      var b = await new Promise(function(res){ canvas.toBlob(res, "image/jpeg", opts.quality); });
      return b ? new Uint8Array(await b.arrayBuffer()) : null;
    }
    if (typeof UPNG === "undefined") return null;
    var imgData = ctx.getImageData(0, 0, w, h);
    // upng-js 2.x returns an ArrayBuffer (no .length!), so compare byteLength
    var quant = UPNG.encode([imgData.data.buffer], w, h, 256);
    var lossless = null;
    if (!quant || quant.byteLength >= originalLength) lossless = UPNG.encode([imgData.data.buffer], w, h, 0);
    var pick = (lossless && lossless.byteLength < quant.byteLength) ? lossless : quant;
    return pick ? new Uint8Array(pick) : null;
  }

  async function compressDocument(file, opts, onProgress) {
    if (typeof fflate === "undefined") throw new Error("fflate library not loaded");
    var ext = extOf(file.name);
    var spec = DOC_KINDS[ext];
    if (!spec) throw new Error("unsupported document type");
    var data = new Uint8Array(await file.arrayBuffer());
    // sync API on purpose: fflate's async path spawns a Worker, which can be
    // blocked on file:// pages; unzipping a document is fast enough to block briefly.
    var entries = fflate.unzipSync(data);
    var mediaNames = Object.keys(entries).filter(function(n){
      return spec.media.test(n) && /\.(jpe?g|png)$/i.test(n);
    });
    var optimized = 0;
    for (var i = 0; i < mediaNames.length; i++) {
      var name = mediaNames[i];
      if (onProgress) onProgress(i + 1, mediaNames.length);
      try {
        var isJpeg = /\.jpe?g$/i.test(name);
        var blob = new Blob([entries[name]], { type: isJpeg ? "image/jpeg" : "image/png" });
        var out = await compressDocImage(blob, isJpeg, opts, entries[name].length);
        if (out && out.length < entries[name].length) {
          entries[name] = out;
          optimized++;
        }
      } catch (e) { /* keep this image untouched */ }
    }
    // Re-zip everything at maximum deflate level. ODF files need the
    // "mimetype" entry first and stored (uncompressed).
    var zipInput = {};
    if (entries["mimetype"]) zipInput["mimetype"] = [entries["mimetype"], { level: 0 }];
    Object.keys(entries).forEach(function(n){
      if (n === "mimetype" || n.slice(-1) === "/") return;
      var already = /\.(jpe?g|png|gif|webp|mp3|mp4|zip)$/i.test(n);
      zipInput[n] = [entries[n], { level: already ? 0 : 9 }];
    });
    var zipped = fflate.zipSync(zipInput);
    // Never hand back a file that is not smaller than the original.
    if (zipped.length >= file.size) return file;
    return new Blob([zipped], { type: spec.mime });
  }

  // ---------- video compression ----------
  function webcodecsReady() {
    return typeof VideoEncoder !== "undefined" &&
           typeof VideoDecoder !== "undefined" &&
           typeof MP4Box !== "undefined" &&
           typeof Mp4Muxer !== "undefined" &&
           !!Mp4Muxer.Muxer &&
           typeof OffscreenCanvas !== "undefined";
  }

  function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
  function evenDim(n) { return Math.max(2, n - (n % 2)); }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  async function compressVideo(file, opts, onProgress) {
    var ext = extOf(file.name);
    if (webcodecsReady() && ext !== "webm" && ext !== "mkv") {
      try {
        return await compressVideoWebCodecs(file, opts, onProgress);
      } catch (e) {
        console.warn("WebCodecs path failed (" + (e && e.message ? e.message : e) + "), falling back to MediaRecorder");
      }
    }
    return compressVideoMediaRecorder(file, opts, onProgress);
  }

  // --- WebCodecs path: mp4box demux -> decode -> resize/fps -> H.264 encode -> mp4-muxer ---
  function demuxMp4(buffer) {
    return new Promise(function(resolve, reject){
      if (buffer.fileStart === undefined) buffer.fileStart = 0;
      var mp4 = MP4Box.createFile();
      mp4.onError = function(e){ reject(new Error("mp4box: " + e)); };
      mp4.onReady = function(info){ resolve({ mp4: mp4, info: info }); };
      mp4.appendBuffer(buffer);
      mp4.flush();
    });
  }

  function codecBoxInfo(mp4, trackId, key) {
    var trak = mp4.getTrackById(trackId);
    if (!trak) return null;
    var entries = trak.mdia.minf.stbl.stsd.entries;
    for (var i = 0; i < entries.length; i++) {
      var box = entries[i][key];
      if (box) {
        var stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8, box.size - 8);
      }
    }
    return null;
  }

  // Walk the MPEG-4 descriptor tree inside an esds payload and return the
  // DecoderSpecificInfo (tag 0x05) bytes = the AAC AudioSpecificConfig that
  // WebCodecs wants as its "description".
  function extractAacConfig(esdsBytes) {
    if (!esdsBytes) return null;
    function walk(start, end) {
      var i = start;
      while (i + 2 <= end) {
        var tag = esdsBytes[i];
        var j = i + 1, size = 0;
        for (var k = 0; k < 4 && j < end; k++) {
          var b = esdsBytes[j++];
          size = (size << 7) | (b & 0x7F);
          if (!(b & 0x80)) break;
        }
        if (j + size > end) return null;
        if (tag === 0x05) return esdsBytes.slice(j, j + size);
        if (tag === 0x03) {
          // ES_Descriptor: ES_ID (2 bytes) + flags (1 byte) sit before children
          var inner = walk(j + 3, j + size);
          if (inner) return inner;
        } else if (tag === 0x04) {
          // DecoderConfigDescriptor: OTI(1) + streamType(1) + bufferSizeDB(3)
          // + maxBitrate(4) + avgBitrate(4) = 13-byte header before children
          var inner2 = walk(j + 13, j + size);
          if (inner2) return inner2;
        }
        i = j + size;
      }
      return null;
    }
    if (!esdsBytes || esdsBytes.length <= 4) return null;
    // the esds box payload starts with a 4-byte version/flags field before the
    // ES_Descriptor tree; fall back to offset 0 for malformed variants
    return walk(4, esdsBytes.length) || walk(0, esdsBytes.length);
  }

  function extractTrackSamples(buffer, trackId) {
    var acc = [];
    return new Promise(function(resolve, reject){
      if (buffer.fileStart === undefined) buffer.fileStart = 0;
      var mp4 = MP4Box.createFile();
      mp4.onError = function(e){ reject(new Error("mp4box: " + e)); };
      mp4.onReady = function(info){
        var track = null;
        for (var i = 0; i < info.tracks.length; i++) {
          if (info.tracks[i].id === trackId) track = info.tracks[i];
        }
        if (!track) { reject(new Error("track not found")); return; }
        var nb = track.nb_samples;
        mp4.onSamples = function(id, user, samples){
          acc = acc.concat(samples);
          if (acc.length >= nb) resolve(acc);
        };
        mp4.setExtractionOptions(trackId, null, { nbSamples: 200 });
        mp4.start();
      };
      mp4.appendBuffer(buffer);
      mp4.flush();
    });
  }

  function h264CodecFor(w, h) {
    if (h <= 720) return "avc1.64001F";
    if (h <= 1080) return "avc1.640028";
    if (h <= 1440) return "avc1.64002A";
    return "avc1.640032";
  }

  function decodeBatch(decoder, batch, sinkRef) {
    return new Promise(function(resolve, reject){
      var frames = [], idx = 0, failed = null, flushing = false;
      sinkRef.sink = {
        frame: function(frame){
          if (failed) { frame.close(); return; }
          frames.push(frame);
          pump();
        },
        fail: function(e){ failed = e; reject(e); }
      };
      function pump(){
        if (failed) return;
        try {
          while (idx < batch.length && decoder.decodeQueueSize < 12) {
            decoder.decode(batch[idx++]);
          }
        } catch (e) {
          failed = e;
          reject(e);
          return;
        }
        if (idx >= batch.length && !flushing) {
          flushing = true;
          decoder.flush().then(function(){
            sinkRef.sink = null;
            resolve(frames);
          }, function(e){
            failed = e;
            reject(e);
          });
        }
      }
      pump();
    });
  }

  function fitFrame(frame, w, h) {
    if (frame.displayWidth === w && frame.displayHeight === h) return frame;
    var canvas = new OffscreenCanvas(w, h);
    var ctx = canvas.getContext("2d");
    ctx.drawImage(frame, 0, 0, w, h);
    return new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined });
  }

  async function compressVideoWebCodecs(file, opts, onProgress) {
    var buffer = await file.arrayBuffer();
    if (buffer.fileStart === undefined) buffer.fileStart = 0;

    var demux = await demuxMp4(buffer);
    var videoTrack = demux.info.videoTracks[0];
    if (!videoTrack) throw new Error("no video track found");
    var vDesc = codecBoxInfo(demux.mp4, videoTrack.id, "avcC") || codecBoxInfo(demux.mp4, videoTrack.id, "hvcC");
    if (!vDesc) throw new Error("only H.264 / HEVC video is supported");
    var audioTrack = demux.info.audioTracks[0] || null;

    var decConfig = { codec: videoTrack.codec, description: vDesc, optimizeForLatency: false };
    var decSupport = await VideoDecoder.isConfigSupported(decConfig);
    if (!decSupport.supported) throw new Error("cannot decode " + videoTrack.codec);

    var outW = evenDim(videoTrack.video.width), outH = evenDim(videoTrack.video.height);
    var maxDim = opts.vMaxDim || 0;
    if (maxDim && Math.max(outW, outH) > maxDim) {
      var r = maxDim / Math.max(outW, outH);
      outW = evenDim(Math.round(outW * r));
      outH = evenDim(Math.round(outH * r));
    }

    var srcFps = videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale);
    var outFps = opts.vFps ? Math.min(srcFps, opts.vFps) : srcFps;
    if (!isFinite(outFps) || outFps <= 0) outFps = 30;

    var encConfig = {
      codec: h264CodecFor(outW, outH),
      width: outW,
      height: outH,
      bitrate: opts.vBitrate,
      framerate: outFps,
      avc: { format: "avc" }
    };
    var encSupport = await VideoEncoder.isConfigSupported(encConfig);
    if (!encSupport.supported) throw new Error("H.264 encoding is not supported in this browser");

    var audioOk = false;
    var aSampleRate = 48000, aChannels = 2;
    var aDescFinal = null;
    if (audioTrack && typeof AudioDecoder !== "undefined" && typeof AudioEncoder !== "undefined") {
      try {
        aSampleRate = audioTrack.audio.sample_rate;
        aChannels = audioTrack.audio.channel_count;
        var esdsRaw = codecBoxInfo(demux.mp4, audioTrack.id, "esds");
        var asc = extractAacConfig(esdsRaw);
        var aEncConfig = {
          codec: "mp4a.40.2",
          sampleRate: aSampleRate,
          numberOfChannels: aChannels,
          bitrate: 128000,
          aac: { format: "adts" }
        };
        var aES = await AudioEncoder.isConfigSupported(aEncConfig);
        if (aES.supported) {
          var candidates = [];
          if (asc) candidates.push(asc);
          if (esdsRaw) candidates.push(esdsRaw);
          candidates.push(null);
          for (var ci = 0; ci < candidates.length; ci++) {
            var aCfg = {
              codec: audioTrack.codec,
              sampleRate: aSampleRate,
              numberOfChannels: aChannels
            };
            if (candidates[ci]) aCfg.description = candidates[ci];
            var aDS = await AudioDecoder.isConfigSupported(aCfg);
            if (aDS.supported) {
              audioOk = true;
              aDescFinal = candidates[ci];
              break;
            }
          }
        }
      } catch (e) { audioOk = false; }
    }
    if (audioTrack && !audioOk) {
      // never ship a silent video: let the MediaRecorder fallback keep the audio
      throw new Error("audio track can't be re-encoded with WebCodecs in this browser");
    }

    var muxerOpts = {
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: outW, height: outH },
      fastStart: "in-memory",
      firstTimestampBehavior: "offset"
    };
    if (audioTrack) {
      muxerOpts.audio = { codec: "aac", numberOfChannels: aChannels, sampleRate: aSampleRate };
    }
    var muxer = new Mp4Muxer.Muxer(muxerOpts);

    var encodeFailed = null;
    var vEncoder = new VideoEncoder({
      output: function(chunk, meta){ muxer.addVideoChunk(chunk, meta); },
      error: function(e){ encodeFailed = e; }
    });
    vEncoder.configure(encConfig);

    var sinkRef = { sink: null };
    var vDecoder = new VideoDecoder({
      output: function(frame){ var s = sinkRef.sink; if (s) s.frame(frame); else frame.close(); },
      error: function(e){ var s = sinkRef.sink; if (s) s.fail(e); }
    });
    vDecoder.configure(decConfig);

    var audioDone = null;
    var aEncoder = null;
    if (audioTrack) {
      var aSinkRef = { sink: null };
      var aDecoder = new AudioDecoder({
        output: function(d){ var s = aSinkRef.sink; if (s) s.frame(d); else d.close(); },
        error: function(e){ var s = aSinkRef.sink; if (s) s.fail(e); }
      });
      aDecoder.configure({
        codec: audioTrack.codec,
        sampleRate: aSampleRate,
        numberOfChannels: aChannels,
        description: aDescFinal || undefined
      });
      aEncoder = new AudioEncoder({
        output: function(chunk, meta){ muxer.addAudioChunk(chunk, meta); },
        error: function(e){ console.error("audio encode error", e); }
      });
      aEncoder.configure({
        codec: "mp4a.40.2",
        sampleRate: aSampleRate,
        numberOfChannels: aChannels,
        bitrate: 128000,
        aac: { format: "adts" }
      });
      audioDone = (async function(){
        var aSamples = await extractTrackSamples(buffer, audioTrack.id);
        var aChunks = aSamples.map(function(s){
          return new EncodedAudioChunk({
            type: "key",
            timestamp: Math.round((s.cts * 1e6) / audioTrack.timescale),
            duration: Math.round(((s.duration || 0) * 1e6) / audioTrack.timescale),
            data: s.data
          });
        });
        var ABATCH = 200;
        for (var i = 0; i < aChunks.length; i += ABATCH) {
          if (encodeFailed) return;
          var frames = await decodeBatch(aDecoder, aChunks.slice(i, i + ABATCH), aSinkRef);
          for (var f = 0; f < frames.length; f++) {
            aEncoder.encode(frames[f]);
            frames[f].close();
          }
          while (aEncoder.encodeQueueSize > 16) await sleep(5);
        }
        await aEncoder.flush();
      })();
    }

    var vSamples = await extractTrackSamples(buffer, videoTrack.id);
    var chunks = vSamples.map(function(s){
      return new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: Math.round((s.cts * 1e6) / videoTrack.timescale),
        duration: Math.round(((s.duration || 0) * 1e6) / videoTrack.timescale),
        data: s.data
      });
    });

    var total = chunks.length, doneCount = 0;
    var lastTs = -Infinity, lastKeyTs = -Infinity;
    var minGap = 1e6 / outFps;
    var VBATCH = 45;
    for (var i = 0; i < total; i += VBATCH) {
      if (encodeFailed) throw encodeFailed;
      var frames = await decodeBatch(vDecoder, chunks.slice(i, i + VBATCH), sinkRef);
      for (var f = 0; f < frames.length; f++) {
        var frame = frames[f];
        var ts = frame.timestamp;
        if (ts - lastTs >= minGap - 500) {
          var outFrame = fitFrame(frame, outW, outH);
          var isKey = ts - lastKeyTs >= 2e6;
          vEncoder.encode(outFrame, { keyFrame: isKey });
          if (isKey) lastKeyTs = ts;
          lastTs = ts;
          if (outFrame !== frame) outFrame.close();
        }
        frame.close();
      }
      while (vEncoder.encodeQueueSize > 8 && !encodeFailed) await sleep(10);
      doneCount += Math.min(VBATCH, total - i);
      if (onProgress) onProgress(doneCount, total);
    }
    if (encodeFailed) throw encodeFailed;
    await vEncoder.flush();
    if (audioDone) await audioDone;

    try { vDecoder.close(); } catch (e) {}
    try { vEncoder.close(); } catch (e) {}
    if (aEncoder) { try { aEncoder.close(); } catch (e) {} }

    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: "video/mp4" });
  }

  // --- MediaRecorder fallback path (real-time re-encode) ---
  function pickRecorderMime() {
    var candidates = ["video/mp4", "video/mp4;codecs=avc1", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (var i = 0; i < candidates.length; i++) {
      try { if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return "";
  }

  function compressVideoMediaRecorder(file, opts, onProgress) {
    return new Promise(function(resolve, reject){
      var url = URL.createObjectURL(file);
      var video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;
      var cleaned = false, finished = false, prog = 0, rec = null, drawRaf = 0;
      function cleanup(){
        if (cleaned) return;
        cleaned = true;
        URL.revokeObjectURL(url);
      }
      function stopProg(){
        if (prog) { clearInterval(prog); prog = 0; }
      }
      function fail(msg){
        if (finished) return;
        finished = true;
        stopProg();
        if (drawRaf) cancelAnimationFrame(drawRaf);
        if (rec) { try { rec.stop(); } catch (e) {} }
        video.pause();
        cleanup();
        reject(new Error(msg));
      }

      video.onloadedmetadata = function(){
        var srcW = video.videoWidth, srcH = video.videoHeight;
        if (!srcW || !srcH) { fail("this video format can't be played in this browser"); return; }
        if (!isFinite(video.duration)) { fail("this video has no known duration, so it can't be re-encoded"); return; }
        var outW = srcW, outH = srcH;
        var maxDim = opts.vMaxDim || 0;
        if (maxDim && Math.max(srcW, srcH) > maxDim) {
          var r = maxDim / Math.max(srcW, srcH);
          outW = evenDim(Math.round(srcW * r));
          outH = evenDim(Math.round(srcH * r));
        }

        var stream = null, canvas = null;
        if (outW !== srcW || outH !== srcH) {
          canvas = document.createElement("canvas");
          canvas.width = outW;
          canvas.height = outH;
          var ctx = canvas.getContext("2d");
          var draw = function(){
            if (video.paused || video.ended) return;
            try { ctx.drawImage(video, 0, 0, outW, outH); } catch (e) {}
            drawRaf = requestAnimationFrame(draw);
          };
          video.addEventListener("playing", function(){
            if (drawRaf) cancelAnimationFrame(drawRaf);
            drawRaf = requestAnimationFrame(draw);
          });
          stream = canvas.captureStream(30);
          if (video.captureStream) {
            var es = video.captureStream();
            var atracks = es.getAudioTracks();
            for (var i = 0; i < atracks.length; i++) stream.addTrack(atracks[i]);
          }
        } else if (video.captureStream) {
          stream = video.captureStream();
        } else if (video.mozCaptureStream) {
          stream = video.mozCaptureStream();
        } else {
          fail("video capture is not supported in this browser");
          return;
        }

        var mime = pickRecorderMime();
        try {
          rec = mime ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.vBitrate }) : new MediaRecorder(stream);
        } catch (e) {
          fail("could not start recorder: " + e.message);
          return;
        }

        var chunks = [];
        rec.ondataavailable = function(e){ if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function(){
          if (finished) return;
          finished = true;
          stopProg();
          if (drawRaf) cancelAnimationFrame(drawRaf);
          video.pause();
          cleanup();
          var outMime = rec.mimeType || mime || "video/webm";
          resolve(new Blob(chunks, { type: outMime }));
        };
        rec.onerror = function(e){
          fail("recording failed: " + (e.error && e.error.message ? e.error.message : "unknown error"));
        };
        prog = setInterval(function(){
          if (onProgress) onProgress(video.currentTime, video.duration, true);
        }, 250);

        rec.start(1000);
        var playP = video.play();
        if (playP && playP.catch) {
          playP.catch(function(e){ fail("could not play this video: " + e.message); });
        }
        video.onended = function(){
          setTimeout(function(){
            if (!finished) {
              try { rec.stop(); } catch (e) { fail("recording failed: " + e.message); }
            }
          }, 250);
        };
      };

      video.onerror = function(){ fail("this video format can't be played in this browser"); };
    });
  }

  // ---------- DOCX -> PDF (separate, optional; produces a real downloadable PDF) ----------
  async function docxToPdf(item, setStatus) {
    if (typeof docx === "undefined" || typeof html2canvas === "undefined") {
      setStatus("PDF libraries not loaded (check your connection)", true);
      return;
    }
    var holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-12000px;top:0;background:#fff;";
    document.body.appendChild(holder);
    try {
      setStatus("Converting to PDF\u2026");
      await docx.renderAsync(item.file, holder, holder, {
        inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false, useBase64URL: true
      });
      await new Promise(function(r){ setTimeout(r, 400); });
      var pages = holder.querySelectorAll("section.docx");
      if (!pages.length) throw new Error("nothing to render");
      var out = await PDFLib.PDFDocument.create();
      for (var i = 0; i < pages.length; i++) {
        setStatus("Converting page " + (i + 1) + " of " + pages.length + "\u2026");
        var canvas = await html2canvas(pages[i], { scale: 1.6, backgroundColor: "#fff", useCORS: true });
        var jpg = await (await fetch(canvas.toDataURL("image/jpeg", 0.8))).arrayBuffer();
        var img = await out.embedJpg(jpg);
        var pg = out.addPage([595.28, 841.89]); // A4
        pg.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
        canvas.width = canvas.height = 0;
      }
      var bytes = await out.save();
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      var dot = item.file.name.lastIndexOf(".");
      a.download = (dot > -1 ? item.file.name.slice(0, dot) : item.file.name) + ".pdf";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
      setStatus("PDF downloaded (" + formatBytes(bytes.length) + "). Your Word file is unchanged.");
    } catch (e) {
      console.error(e);
      setStatus("Couldn't convert to PDF (" + (e && e.message ? e.message : "error") + ")", true);
    } finally {
      if (holder.parentNode) holder.parentNode.removeChild(holder);
    }
  }

  // ---------- queue ----------
  var queue = Promise.resolve();
  function enqueue(task) {
    var result = queue.then(task, task);
    queue = result.catch(function(){});
    return result;
  }

  // ---------- items & rendering ----------
  var items = [];
  var listEl = document.getElementById("list");
  var emptyMsg = document.getElementById("emptyMsg");
  var qualityEl = document.getElementById("quality");
  var qualityValueEl = document.getElementById("qualityValue");
  var resolutionEl = document.getElementById("resolution");
  var limitWidthEl = document.getElementById("limitWidth");
  var videoControlsEl = document.getElementById("videoControls");
  var vBitrateEl = document.getElementById("vBitrate");
  var vMaxDimEl = document.getElementById("vMaxDim");
  var vFpsEl = document.getElementById("vFps");

  function currentOpts() {
    return {
      quality: parseInt(qualityEl.value, 10) / 100,
      scale: parseFloat(resolutionEl.value),
      maxWidth: limitWidthEl.checked ? 1920 : null,
      vBitrate: parseInt(vBitrateEl.value, 10) * 1e6,
      vMaxDim: parseInt(vMaxDimEl.value, 10) || 0,
      vFps: parseInt(vFpsEl.value, 10) || 0
    };
  }

  var DOC_KINDS = {
    docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", media: /^word\/media\// },
    xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", media: /^xl\/media\// },
    pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", media: /^ppt\/media\// },
    odt: { mime: "application/vnd.oasis.opendocument.text", media: /^Pictures\// },
    ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", media: /^Pictures\// },
    odp: { mime: "application/vnd.oasis.opendocument.presentation", media: /^Pictures\// }
  };

  function extOf(name) {
    var dot = name.lastIndexOf(".");
    return dot > -1 ? name.slice(dot + 1).toLowerCase() : "";
  }

  function kindOf(file) {
    var ext = extOf(file.name);
    if (file.type === "application/pdf" || ext === "pdf") return "pdf";
    if (/^(mp4|m4v|mov|webm|mkv)$/.test(ext)) return "video";
    if (DOC_KINDS[ext]) return "document";
    if (/^(jpe?g|png|webp)$/.test(ext) || /^image\/(jpeg|png|webp)$/.test(file.type)) return "image";
    return "unsupported";
  }

  function updateEmptyState() { applySection(); }

  function buildRow(item) {
    var row = document.createElement("div");
    row.className = "item";
    row.setAttribute("data-kind", item.kind === "document" ? "doc" : item.kind);
    row.setAttribute("data-section", item.kind);
    row.innerHTML =
      '<div class="item-top">' +
        '<div class="name" title="' + item.file.name.replace(/"/g,"&quot;") + '">' + item.file.name + '</div>' +
        '<div class="size before">' + formatBytes(item.originalSize) + '</div>' +
        '<div class="arrow">&rarr;</div>' +
        '<div class="size after" data-role="after">&mdash;</div>' +
        '<div class="pct" data-role="pct"></div>' +
      '</div>' +
      '<div class="bar-track"><div class="bar-fill" data-role="bar"></div></div>' +
      '<div class="status" data-role="status">Waiting&hellip;</div>';

    var actions = document.createElement("div");
    actions.className = "actions";
    actions.style.marginTop = "10px";

    var dlBtn = document.createElement("button");
    dlBtn.className = "primary";
    dlBtn.textContent = "Download";
    dlBtn.disabled = true;
    dlBtn.addEventListener("click", function(){
      if (!item.compressedBlob) return;
      var a = document.createElement("a");
      a.href = URL.createObjectURL(item.compressedBlob);
      var dot = item.file.name.lastIndexOf(".");
      var base = dot > -1 ? item.file.name.slice(0, dot) : item.file.name;
      var ext;
      if (item.kind === "pdf") ext = "pdf";
      else if (item.kind === "video") ext = item.compressedBlob.type.indexOf("mp4") > -1 ? "mp4" : "webm";
      else if (item.kind === "document") ext = extOf(item.file.name);
      else ext = item.compressedBlob.type === "image/webp" ? "webp" : "jpg";
      a.download = base + "-compressed." + ext;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
    });

    var rmBtn = document.createElement("button");
    rmBtn.className = "icon";
    rmBtn.textContent = "Remove";
    rmBtn.addEventListener("click", function(){
      items = items.filter(function(it){ return it.id !== item.id; });
      row.remove();
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      updateEmptyState();
      updateControlVisibility();
    });

    actions.appendChild(dlBtn);
    if (item.kind === "document" && extOf(item.file.name) === "docx") {
      var pdfBtn = document.createElement("button");
      pdfBtn.className = "icon";
      pdfBtn.textContent = "Convert to PDF";
      pdfBtn.addEventListener("click", function(){
        docxToPdf(item, function(text, isError){ setStatus(item, text, isError); });
      });
      actions.appendChild(pdfBtn);
    }
    actions.appendChild(rmBtn);

    row.appendChild(actions);

    if (item.kind === "video") {
      var thumb = document.createElement("video");
      thumb.className = "thumb";
      thumb.muted = true;
      thumb.playsInline = true;
      thumb.preload = "metadata";
      item.thumbUrl = URL.createObjectURL(item.file);
      thumb.src = item.thumbUrl;
      row.insertBefore(thumb, actions);
    }

    item.el = row;
    item.dlBtn = dlBtn;
    item.afterEl = row.querySelector('[data-role="after"]');
    item.pctEl = row.querySelector('[data-role="pct"]');
    item.barEl = row.querySelector('[data-role="bar"]');
    item.statusEl = row.querySelector('[data-role="status"]');

    return row;
  }

  function setStatus(item, text, isError) {
    item.statusEl.textContent = text;
    item.statusEl.classList.toggle("err", !!isError);
  }

  function applyResult(item, blob) {
    if (blob === item.file) {
      item.compressedBlob = blob;
      item.afterEl.textContent = formatBytes(blob.size);
      item.pctEl.textContent = "\u2014";
      item.barEl.style.width = "0%";
      item.dlBtn.disabled = false;
      setStatus(item, "Ready \u2014 nothing to compress in this file");
      return;
    }
    var prevDisplayed = item.lastDisplayedSize || item.originalSize;
    item.compressedBlob = blob;
    item.compressedSize = blob.size;
    item.lastDisplayedSize = blob.size;

    animateNumber(item.afterEl, prevDisplayed, blob.size, formatBytes);

    var pct = Math.round((1 - blob.size / item.originalSize) * 100);
    item.pctEl.textContent = (pct >= 0 ? "-" : "+") + Math.abs(pct) + "%";
    item.pctEl.style.color = pct >= 0 ? "var(--after)" : "var(--danger)";

    var barPct = Math.max(0, Math.min(100, pct));
    requestAnimationFrame(function(){ item.barEl.style.width = barPct + "%"; });

    item.dlBtn.disabled = false;
    setStatus(item, pct >= 0 ? "Ready" : "Ready (larger than original at this quality — try lowering it)");
  }

  function processItem(item) {
    return enqueue(function(){
      item.dlBtn.disabled = true;
      setStatus(item, item.kind === "pdf" ? "Rendering pages\u2026" : "Compressing\u2026");
      var opts = currentOpts();

      var work;
      if (item.kind === "image") {
        work = compressImage(item.file, opts);
      } else if (item.kind === "pdf") {
        work = compressPdf(item.file, opts, function(done, total){
          setStatus(item, "Rendering page " + done + " of " + total + "\u2026");
        });
      } else if (item.kind === "video") {
        work = compressVideo(item.file, opts, function(a, b, isTime){
          if (isTime) {
            setStatus(item, "Encoding " + formatTime(a) + (b > 0 ? " / " + formatTime(b) : "") + "\u2026");
          } else {
            setStatus(item, "Encoding frame " + a + " of " + b + "\u2026");
          }
        });
      } else if (item.kind === "document") {
        work = compressDocument(item.file, opts, function(done, total){
          setStatus(item, "Compressing image " + done + " of " + total + "\u2026");
        });
      } else {
        setStatus(item, "Unsupported file type", true);
        return Promise.resolve();
      }

      return work.then(function(blob){
        applyResult(item, blob);
      }).catch(function(err){
        console.error(err);
        setStatus(item, "Couldn't process this file (" + (err && err.message ? err.message : "error") + ")", true);
      });
    });
  }

  function addFiles(fileList) {
    Array.prototype.forEach.call(fileList, function(file){
      var kind = kindOf(file);
      var item = {
        id: Math.random().toString(36).slice(2),
        file: file,
        kind: kind,
        originalSize: file.size
      };
      items.push(item);
      var row = buildRow(item);
      listEl.appendChild(row);
      updateEmptyState();
      updateControlVisibility();
      if (kind === "unsupported") {
        setStatus(item, /\.(avi|wmv|flv|ts|m2ts)$/i.test(item.file.name) ? "Unsupported video format \u2014 use MP4, WebM or MOV" : "Unsupported file type", true);
      } else {
        processItem(item);
      }
    });
    var added = items.slice(-fileList.length);
    var okAdded = added.filter(function(it){ return it.kind !== "unsupported"; });
    if (okAdded.length && !okAdded.some(function(it){ return it.kind === currentSection; })) switchSection(okAdded[0].kind);
  }

  function reprocessKinds(kinds) {
    items.forEach(function(item){
      if (kinds.indexOf(item.kind) > -1) processItem(item);
    });
  }

  function updateControlVisibility() { applySection(); }

  // ---------- controls wiring ----------
  var qualityDebounce;
  qualityEl.addEventListener("input", function(){
    qualityValueEl.textContent = qualityEl.value + "%";
  });
  qualityEl.addEventListener("change", function(){
    clearTimeout(qualityDebounce);
    qualityDebounce = setTimeout(function(){ reprocessKinds(["image", "pdf", "document"]); }, 150);
  });
  resolutionEl.addEventListener("change", function(){ reprocessKinds(["pdf"]); });
  limitWidthEl.addEventListener("change", function(){ reprocessKinds(["image", "document"]); });
  vBitrateEl.addEventListener("change", function(){ reprocessKinds(["video"]); });
  vMaxDimEl.addEventListener("change", function(){ reprocessKinds(["video"]); });
  vFpsEl.addEventListener("change", function(){ reprocessKinds(["video"]); });

  // ---------- dropzone wiring ----------
  var dropzone = document.getElementById("dropzone");
  var fileInput = document.getElementById("fileInput");

  dropzone.addEventListener("click", function(){ fileInput.click(); });
  dropzone.addEventListener("keydown", function(e){
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function(){
    if (fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = "";
  });
  ["dragenter","dragover"].forEach(function(evt){
    dropzone.addEventListener(evt, function(e){
      e.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave","drop"].forEach(function(evt){
    dropzone.addEventListener(evt, function(e){
      e.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", function(e){
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // ---------- QR code generator ----------
  var qrType = "text";
  var qrCurrent = null; // { qr, n }
  var qrCanvas = document.getElementById("qrCanvas");
  var qrEmpty = document.getElementById("qrEmpty");
  var qrPngBtn = document.getElementById("qrPng");
  var qrSvgBtn = document.getElementById("qrSvg");
  var fgHex = document.getElementById("fgHex"), bgHex = document.getElementById("bgHex");
  var fgPicker = document.getElementById("fgPicker"), bgPicker = document.getElementById("bgPicker");
  var qrEcc = document.getElementById("qrEcc"), qrMargin = document.getElementById("qrMargin"), qrSize = document.getElementById("qrSize");

  function qrEscape(v) { return String(v).replace(/([\\;,:"])/g, "\\$1"); }
  function qrPayload() {
    function val(id) { return document.getElementById(id).value; }
    if (qrType === "text") return val("qText").trim();
    if (qrType === "phone") { var ph = val("qPhone").replace(/[^\d+]/g, ""); return ph ? "tel:" + ph : ""; }
    if (qrType === "email") {
      var em = val("qEmail").trim(); if (!em) return "";
      var q = [];
      if (val("qSubject")) q.push("subject=" + encodeURIComponent(val("qSubject")));
      if (val("qBody")) q.push("body=" + encodeURIComponent(val("qBody")));
      return "mailto:" + em + (q.length ? "?" + q.join("&") : "");
    }
    var ssid = val("qSsid"); if (!ssid) return "";
    var t = val("qWifiType");
    return "WIFI:T:" + t + ";S:" + qrEscape(ssid) + ";" + (t === "nopass" ? "" : "P:" + qrEscape(val("qWifiPass")) + ";") + ";";
  }
  function validHex(v) { return /^#[0-9a-f]{6}$/i.test(v); }
  function lum(hex) {
    var c = [1,3,5].map(function(i){ var x = parseInt(hex.substr(i,2),16)/255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
    return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2];
  }
  function qrColors() {
    return { fg: validHex(fgHex.value) ? fgHex.value : fgPicker.value, bg: validHex(bgHex.value) ? bgHex.value : bgPicker.value };
  }
  function drawQr() {
    var text = qrPayload();
    var cols = qrColors();
    var warn = document.getElementById("qrWarn");
    var l1 = lum(cols.fg), l2 = lum(cols.bg);
    var ratio = (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
    warn.textContent = ratio < 3 ? "Low contrast \u2014 this QR code may be hard to scan. Pick colors that differ more." : (l1 > l2 ? "Tip: a darker code on a lighter background scans most reliably." : "");
    qrCurrent = null;
    qrPngBtn.disabled = qrSvgBtn.disabled = true;
    if (!text) { qrCanvas.hidden = true; qrEmpty.hidden = false; qrEmpty.textContent = "Type something to generate your QR code."; return; }
    try {
      var qr = qrcode(0, qrEcc.value);
      qr.addData(unescape(encodeURIComponent(text))); // UTF-8 bytes
      qr.make();
    } catch (e) {
      qrCanvas.hidden = true; qrEmpty.hidden = false; qrEmpty.textContent = "That's too much content for one QR code. Try shortening it or lowering error correction.";
      return;
    }
    var n = qr.getModuleCount();
    qrCurrent = { qr: qr, n: n };
    var m = parseInt(qrMargin.value, 10);
    var cell = Math.max(4, Math.floor(512 / (n + 2*m)));
    var dim = cell * (n + 2*m);
    qrCanvas.width = qrCanvas.height = dim;
    var ctx = qrCanvas.getContext("2d");
    ctx.fillStyle = cols.bg; ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = cols.fg;
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c+m)*cell, (r+m)*cell, cell, cell);
    qrCanvas.hidden = false; qrEmpty.hidden = true;
    qrPngBtn.disabled = qrSvgBtn.disabled = false;
  }
  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
  }
  qrPngBtn.addEventListener("click", function(){
    if (!qrCurrent) return;
    var cols = qrColors(), n = qrCurrent.n, m = parseInt(qrMargin.value, 10);
    var target = parseInt(qrSize.value, 10);
    var cell = Math.max(1, Math.floor(target / (n + 2*m)));
    var dim = cell * (n + 2*m);
    var cv = document.createElement("canvas"); cv.width = cv.height = dim;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = cols.bg; ctx.fillRect(0, 0, dim, dim); ctx.fillStyle = cols.fg;
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qrCurrent.qr.isDark(r, c)) ctx.fillRect((c+m)*cell, (r+m)*cell, cell, cell);
    cv.toBlob(function(b){ if (b) saveBlob(b, "qr-code.png"); }, "image/png");
  });
  qrSvgBtn.addEventListener("click", function(){
    if (!qrCurrent) return;
    var cols = qrColors(), n = qrCurrent.n, m = parseInt(qrMargin.value, 10), d = n + 2*m, path = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qrCurrent.qr.isDark(r, c)) path += "M" + (c+m) + " " + (r+m) + "h1v1h-1z";
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + d + ' ' + d + '" width="' + qrSize.value + '" height="' + qrSize.value + '" shape-rendering="crispEdges"><rect width="' + d + '" height="' + d + '" fill="' + cols.bg + '"/><path d="' + path + '" fill="' + cols.fg + '"/></svg>';
    saveBlob(new Blob([svg], { type: "image/svg+xml" }), "qr-code.svg");
  });
  function syncSwatches() {
    Array.prototype.forEach.call(document.querySelectorAll(".swatch"), function(sw){
      var cur = (sw.getAttribute("data-target") === "fg" ? fgPicker.value : bgPicker.value).toLowerCase();
      sw.classList.toggle("sel", sw.getAttribute("data-color").toLowerCase() === cur);
    });
  }
  function setColor(target, hex) {
    var picker = target === "fg" ? fgPicker : bgPicker, input = target === "fg" ? fgHex : bgHex;
    picker.value = hex; input.value = hex.toUpperCase();
    syncSwatches(); drawQr();
  }
  Array.prototype.forEach.call(document.querySelectorAll(".swatch"), function(sw){
    sw.addEventListener("click", function(){ setColor(sw.getAttribute("data-target"), sw.getAttribute("data-color")); });
  });
  [["fg", fgPicker, fgHex], ["bg", bgPicker, bgHex]].forEach(function(t){
    t[1].addEventListener("input", function(){ setColor(t[0], t[1].value); });
    t[2].addEventListener("input", function(){
      var v = t[2].value.trim(); if (v && v[0] !== "#") v = "#" + v;
      if (validHex(v)) { t[1].value = v; syncSwatches(); drawQr(); }
    });
    t[2].addEventListener("blur", function(){ t[2].value = t[1].value.toUpperCase(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll("#qrTabs .tab"), function(tab){
    tab.addEventListener("click", function(){
      qrType = tab.getAttribute("data-type");
      Array.prototype.forEach.call(document.querySelectorAll("#qrTabs .tab"), function(x){ x.classList.toggle("active", x === tab); });
      Array.prototype.forEach.call(document.querySelectorAll("[data-qtype]"), function(b){ b.hidden = b.getAttribute("data-qtype") !== qrType; });
      drawQr();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-qtype] input, [data-qtype] textarea, [data-qtype] select"), function(el){
    el.addEventListener("input", drawQr); el.addEventListener("change", drawQr);
  });
  qrEcc.addEventListener("change", drawQr);
  qrMargin.addEventListener("input", function(){ document.getElementById("qrMarginVal").textContent = qrMargin.value; drawQr(); });
  qrSize.addEventListener("input", function(){ document.getElementById("qrSizeVal").textContent = qrSize.value + "px"; });
  syncSwatches();

  // ---------- sidebar & sections ----------
  var SECTIONS = {
    image: { title: "Images", h: "Compress images", desc: "Shrink JPG, PNG and WEBP images while keeping them sharp. Adjust quality and see the savings instantly.", types: "JPG \u00b7 PNG \u00b7 WEBP", accept: "image/jpeg,image/png,image/webp" },
    video: { title: "Videos", h: "Compress videos", desc: "Reduce MP4, WebM and MOV videos by lowering bitrate, resolution or frame rate.", types: "MP4 \u00b7 WEBM \u00b7 MOV", accept: "video/mp4,video/webm,video/quicktime" },
    pdf: { title: "PDFs", h: "Compress PDFs", desc: "Make PDF files smaller. Scanned and image-heavy PDFs shrink the most.", types: "PDF", accept: "application/pdf" },
    document: { title: "Documents", h: "Compress documents", desc: "Compress Word, Excel and PowerPoint files and keep them in their original format. Word files can optionally be converted to PDF.", types: "DOCX \u00b7 XLSX \u00b7 PPTX \u00b7 ODT \u00b7 ODS \u00b7 ODP", accept: ".docx,.xlsx,.pptx,.odt,.ods,.odp" },
    qr: { title: "QR Code", h: "QR code generator", desc: "Create a QR code for a link, text, email, phone number or WiFi network, then pick your own colors and download it as PNG or SVG.", types: "", accept: "" }
  };
  var currentSection = "image";
  var shellEl = document.getElementById("shell");
  var mqMobile = window.matchMedia("(max-width: 767px)");

  function applySection() {
    var sec = SECTIONS[currentSection];
    document.getElementById("pageTitle").textContent = sec.h;
    document.getElementById("pageDesc").textContent = sec.desc;
    document.getElementById("crumb").textContent = sec.title;
    document.getElementById("dzTypes").textContent = sec.types;
    fileInput.setAttribute("accept", sec.accept);
    Array.prototype.forEach.call(document.querySelectorAll(".nav-btn[data-section]"), function(b){
      b.classList.toggle("active", b.getAttribute("data-section") === currentSection);
      if (b.classList.contains("active")) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-for]"), function(c){
      c.hidden = c.getAttribute("data-for").split(" ").indexOf(currentSection) === -1;
    });
    var shown = 0;
    items.forEach(function(it){
      var match = it.kind === currentSection || (it.kind === "unsupported");
      if (it.el) it.el.hidden = !match;
      if (match) shown++;
    });
    emptyMsg.style.display = shown ? "none" : "block";
    var isQr = currentSection === "qr";
    ["mainControls", "dropzone", "list"].forEach(function(id){ document.getElementById(id).hidden = isQr; });
    document.getElementById("qrPanel").hidden = !isQr;
    if (isQr) drawQr();
    Object.keys(SECTIONS).forEach(function(k){
      var n = items.filter(function(it){ return it.kind === k; }).length;
      var el = document.querySelector('[data-count="' + k + '"]');
      if (el) el.textContent = n ? String(n) : "";
    });
  }
  function switchSection(k) {
    currentSection = k;
    applySection();
    setMobileOpen(false);
  }
  function setMobileOpen(open) { shellEl.classList.toggle("mobile-open", open); }
  function toggleSidebar() {
    if (mqMobile.matches) setMobileOpen(!shellEl.classList.contains("mobile-open"));
    else shellEl.classList.toggle("collapsed");
  }
  Array.prototype.forEach.call(document.querySelectorAll(".nav-btn[data-section]"), function(b){
    b.addEventListener("click", function(){ switchSection(b.getAttribute("data-section")); });
  });
  document.getElementById("sbTrigger").addEventListener("click", toggleSidebar);
  document.getElementById("sbClose").addEventListener("click", function(){ setMobileOpen(false); });
  document.getElementById("scrim").addEventListener("click", function(){ setMobileOpen(false); });
  window.addEventListener("keydown", function(e){
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
    if (e.key === "Escape") setMobileOpen(false);
  });
  applySection();

})();
