/* global Quagga */
(function(){
  "use strict";

  function onlyDigits(s){
    return String(s || "").replace(/[^0-9]/g, "");
  }

  // EAN/GTIN mod10
  function checkMod10(numStr){
    var s = onlyDigits(numStr);
    if(s.length < 8) return false;
    var sum = 0;
    var alt = true; // from rightmost (excluding check digit)
    for(var i=s.length-2;i>=0;i--){
      var n = parseInt(s.charAt(i),10);
      sum += alt ? n*3 : n;
      alt = !alt;
    }
    var cd = (10 - (sum % 10)) % 10;
    return cd === parseInt(s.charAt(s.length-1),10);
  }

  function normalizeJan13(raw){
    var d = onlyDigits(raw);
    if(d.length === 13 && checkMod10(d)) return d;
    // some scanners produce leading 0 / trailing
    if(d.length > 13){
      // try last 13
      var t = d.slice(d.length-13);
      if(checkMod10(t)) return t;
    }
    return null;
  }

  // GS1-128 の AI(01) GTIN14 抽出（簡易）
  function parseGS1ForGTIN14(raw){
    var s = String(raw || "");
    // AI(01) の表現揺れを吸収： "(01)xxxxxxxxxxxxxx" or "01xxxxxxxxxxxxxx"
    var m = s.match(/\(01\)\s*([0-9]{14})/);
    if(m && m[1]) return m[1];
    m = s.match(/01\s*([0-9]{14})/);
    if(m && m[1]) return m[1];
    return null;
  }

  // Quagga2 wrapper
  function Scanner(opts){
    this.targetEl = opts.targetEl;
    this.onDetected = opts.onDetected;
    this.onError = opts.onError;

    this._running = false;
    this._last = { code:null, t:0, hit:0 };
  }

  Scanner.prototype.isRunning = function(){ return this._running; };

  Scanner.prototype.start = function(){
    var self = this;
    if(self._running) return;

    if(!window.Quagga){
      if(self.onError) self.onError(new Error("Quagga2 が読み込めませんでした"));
      return;
    }

    // ROI中央帯（上下に複数バーコードがある現場を想定）
    var roiTop = 0.30;
    var roiBottom = 0.70;
    var roiLeft = 0.16;
    var roiRight = 0.84;

    try{
      Quagga.init({
        inputStream: {
          name: "Live",
          type: "LiveStream",
          target: self.targetEl,
          constraints: {
            facingMode: "environment"
          },
          area: {
            top: (roiTop*100).toFixed(0) + "%",
            right: ((1-roiRight)*100).toFixed(0) + "%",
            left: (roiLeft*100).toFixed(0) + "%",
            bottom: ((1-roiBottom)*100).toFixed(0) + "%"
          }
        },
        locator: { patchSize: "medium", halfSample: true },
        numOfWorkers: 0, // iOS Safari安全
        frequency: 10,
        decoder: {
          readers: [
            "ean_reader",
            "ean_13_reader",
            "code_128_reader"
          ]
        },
        locate: true
      }, function(err){
        if(err){
          if(self.onError) self.onError(err);
          return;
        }
        try{
          Quagga.onDetected(function(result){
            try{
              var code = result && result.codeResult ? result.codeResult.code : null;
              if(!code) return;

              var raw = String(code);
              var jan13 = normalizeJan13(raw);
              var gtin14 = parseGS1ForGTIN14(raw);

              // 不明抑制：double-hit（短時間に2回同じなら採用）
              var now = Date.now();
              if(self._last.code === raw && (now - self._last.t) < 900){
                self._last.hit += 1;
              }else{
                self._last.code = raw;
                self._last.t = now;
                self._last.hit = 1;
              }
              if(self._last.hit < 2) return;

              if(self.onDetected){
                self.onDetected({ raw: raw, jan13: jan13, gtin14: gtin14 });
              }
            }catch(e){
              if(self.onError) self.onError(e);
            }
          });

          Quagga.start();
          self._running = true;
        }catch(e2){
          if(self.onError) self.onError(e2);
        }
      });
    }catch(e3){
      if(self.onError) self.onError(e3);
    }
  };

  Scanner.prototype.stop = function(){
    var self = this;
    if(!self._running) return;
    try{
      Quagga.stop();
    }catch(e){}
    self._running = false;
  };

  // expose
  window.LinQScanner = {
    Scanner: Scanner,
    normalizeJan13: normalizeJan13,
    parseGS1ForGTIN14: parseGS1ForGTIN14
  };
})();