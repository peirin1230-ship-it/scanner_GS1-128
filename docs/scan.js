// scan.js - Quagga2 wrapper for iPhone Safari

export function parseGS1ForGTIN14(raw) {
  const s = String(raw || "");
  // (01)xxxxxxxxxxxxxx
  let m = s.match(/\(01\)\s*(\d{14})/);
  if (m) return m[1];
  // ]C1 01xxxxxxxxxxxxxx
  m = s.match(/]C1\s*01(\d{14})/);
  if (m) return m[1];
  // fallback 01xxxxxxxxxxxxxx
  m = s.match(/01(\d{14})/);
  if (m) return m[1];
  return null;
}

export function normalizeJan13(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  return s.length === 13 ? s : null;
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

export class Scanner {
  constructor({ targetEl, onDetected, onError }){
    this.targetEl = targetEl;
    this.onDetected = onDetected;
    this.onError = onError;
    this._running = false;
    this._starting = false;
    this._handler = null;
    this._last = 0;
  }

  isRunning(){ return this._running; }

  async start(){
    if (this._running || this._starting) return;
    if (!window.Quagga) { this.onError?.(new Error("Quagga2 not loaded")); return; }
    this._starting = true;

    const config = {
      inputStream: {
        name: "Live",
        type: "LiveStream",
        target: this.targetEl,
        constraints: { facingMode: "environment" },
        // 中央だけ読む（安定）
        area: { top:"22%", right:"14%", left:"14%", bottom:"22%" }
      },
      locate: false,
      numOfWorkers: 0,
      frequency: 6,
      decoder: {
        readers: ["ean_reader", "code_128_reader"],
        multiple: false
      }
    };

    try{
      await new Promise((res, rej) => window.Quagga.init(config, (e)=> e?rej(e):res()));

      this._handler = (r) => {
        const code = r?.codeResult?.code;
        if (!code) return;
        const now = Date.now();
        if (now - this._last < 120) return; // Quagga側の微細連続対策
        this._last = now;
        this.onDetected?.(code);
      };

      window.Quagga.onDetected(this._handler);
      window.Quagga.start();
      await sleep(150);
      this._running = true;
    } catch(e){
      this.onError?.(e);
    } finally {
      this._starting = false;
    }
  }

  stop(){
    try{
      if (!window.Quagga) return;
      if (this._handler){
        window.Quagga.offDetected(this._handler);
        this._handler = null;
      }
      if (this._running) window.Quagga.stop();
    } finally {
      this._running = false;
      this._starting = false;
    }
  }
}