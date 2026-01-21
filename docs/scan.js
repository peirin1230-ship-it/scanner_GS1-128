// scan.js
// Quagga2 wrapper for iPhone Safari stability:
// - prevent multi-start
// - locate=false (avoid crash on some iOS)
// - ROI (central region)
// - parse EAN-13 and Code128(GS1-128) for GTIN14 (AI 01)

export function parseGS1ForGTIN14(raw) {
  // Expect GS1-128 encoded string often like: "]C10101234567890128..."
  // Many decoders may output raw with parentheses or without.
  // We'll extract AI(01) 14 digits by patterns:
  const s = String(raw || "");
  // common forms:
  // (01)12345678901234
  // 0112345678901234
  // ]C10112345678901234
  let m = s.match(/\(01\)\s*(\d{14})/);
  if (m) return m[1];
  m = s.match(/]C1\s*01(\d{14})/);
  if (m) return m[1];
  m = s.match(/01(\d{14})/);
  if (m) return m[1];
  return null;
}

export function normalizeJan13(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (s.length === 13) return s;
  return null;
}

export function normalizeGtin14(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (s.length === 14) return s;
  return null;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

export class Scanner {
  constructor({ targetEl, onDetected, onError, onLog }){
    this.targetEl = targetEl;
    this.onDetected = onDetected;
    this.onError = onError;
    this.onLog = onLog;
    this._running = false;
    this._starting = false;
    this._lastEmitTs = 0;
    this._handler = null;
  }

  isRunning(){ return this._running; }

  async start({ prefer = "ean13" } = {}) {
    if (this._running || this._starting) {
      this.onLog?.("Scanner: start ignored (already starting/running)");
      return;
    }
    if (!window.Quagga) {
      this.onError?.(new Error("Quagga2 not loaded. Check CDN script."));
      return;
    }
    this._starting = true;

    // ROI in the center; values are percentages (0..1)
    const roi = { top: 0.22, right: 0.14, bottom: 0.22, left: 0.14 };

    const readers = [
      "ean_reader",      // EAN-13 (JAN)
      "code_128_reader"  // GS1-128 (Code128)
    ];

    const config = {
      inputStream: {
        name: "Live",
        type: "LiveStream",
        target: this.targetEl,
        constraints: {
          facingMode: "environment",
          // width/height left flexible for iOS
        },
        area: { // ROI
          top: `${roi.top * 100}%`,
          right: `${roi.right * 100}%`,
          left: `${roi.left * 100}%`,
          bottom: `${roi.bottom * 100}%`,
        }
      },
      locate: false,
      numOfWorkers: 0, // important for Safari
      frequency: 6,
      decoder: {
        readers,
        multiple: false
      },
      locator: {
        halfSample: true
      }
    };

    try {
      await new Promise((resolve, reject) => {
        window.Quagga.init(config, (err) => {
          if (err) return reject(err);
          return resolve();
        });
      });

      // Debounce to avoid double-firing on iOS
      this._handler = (result) => {
        try {
          const code = result?.codeResult?.code;
          if (!code) return;
          const now = Date.now();
          if (now - this._lastEmitTs < 900) return;
          this._lastEmitTs = now;
          this.onDetected?.(code, result);
        } catch (e) {
          this.onError?.(e);
        }
      };

      window.Quagga.onDetected(this._handler);
      window.Quagga.start();

      // give camera time to warm up
      await sleep(200);
      this._running = true;
      this.onLog?.("Scanner: started");
    } catch (e) {
      this.onError?.(e);
    } finally {
      this._starting = false;
    }
  }

  stop() {
    try {
      if (!window.Quagga) return;
      if (this._handler) {
        window.Quagga.offDetected(this._handler);
        this._handler = null;
      }
      if (this._running) {
        window.Quagga.stop();
      }
    } catch (e) {
      this.onError?.(e);
    } finally {
      this._running = false;
      this._starting = false;
      this.onLog?.("Scanner: stopped");
    }
  }
}

