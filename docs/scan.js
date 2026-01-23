/* global Quagga */
(function () {
  'use strict';

  function nowMs() { return new Date().getTime(); }

  function stripNonPrintable(s) {
    if (!s) return '';
    // GS1のFNC1(ASCII 29) 等を除去
    return String(s).replace(/\u001d/g, '').trim();
  }

  function extractGTIN14FromGS1(raw) {
    // (01)xxxxxxxxxxxxxx または 01xxxxxxxxxxxxxx を想定
    if (!raw) return null;
    var s = stripNonPrintable(raw);
    var m = s.match(/\(\s*01\s*\)(\d{14})/);
    if (m && m[1]) return m[1];
    m = s.match(/(^|[^0-9])01(\d{14})/);
    if (m && m[2]) return m[2];
    // まれに code128 が 14桁だけ返すケース
    m = s.match(/^\d{14}$/);
    if (m) return s;
    return null;
  }

  function eanMod10Valid(code) {
    // EAN-13 / GTIN-14 のmod10（右端がチェック）
    if (!code) return false;
    var s = String(code).replace(/\D/g, '');
    if (!(s.length === 13 || s.length === 14)) return false;

    var sum = 0;
    var i;
    var len = s.length;
    // 右端(チェック)以外を計算
    for (i = len - 2; i >= 0; i--) {
      var digit = parseInt(s.charAt(i), 10);
      var posFromRight = (len - 2) - i; // 0,1,2...
      // EAN系：右から奇数位置×3（チェック除外後）
      if ((posFromRight % 2) === 0) sum += digit * 3;
      else sum += digit;
    }
    var check = (10 - (sum % 10)) % 10;
    var last = parseInt(s.charAt(len - 1), 10);
    return check === last;
  }

  var Scanner = {
    _running: false,
    _onDetected: null,
    _lastCode: null,
    _lastTs: 0,
    _hitCount: 0,
    _opts: null,

    start: function (opts, onDetected) {
      if (this._running) return;
      this._opts = opts || {};
      this._onDetected = onDetected;

      var target = document.getElementById('scannerTarget');
      if (!target) throw new Error('scannerTarget element not found');

      var roi = this._opts.roi || {};
      // 中央帯デフォルト：top/bottom 30%, 左右 16%
      var area = {
        top: (roi.topPct != null ? String(roi.topPct) : '30') + '%',
        right: (roi.rightPct != null ? String(roi.rightPct) : '16') + '%',
        left: (roi.leftPct != null ? String(roi.leftPct) : '16') + '%',
        bottom: (roi.bottomPct != null ? String(roi.bottomPct) : '30') + '%'
      };

      var readers = [];
      // JAN/EAN-13優先
      readers.push('ean_reader');
      readers.push('ean_13_reader');
      // GS1-128(Code128)対応
      readers.push('code_128_reader');

      var config = {
        inputStream: {
          type: 'LiveStream',
          target: target,
          constraints: {
            facingMode: 'environment'
          },
          area: area
        },
        locator: {
          halfSample: true,
          patchSize: 'medium'
        },
        numOfWorkers: 0,
        frequency: 10,
        decoder: { readers: readers },
        locate: true
      };

      var self = this;

      Quagga.init(config, function (err) {
        if (err) {
          throw err;
        }
        Quagga.onDetected(self._handleDetected.bind(self));
        Quagga.start();
        self._running = true;
      });
    },

    stop: function () {
      if (!this._running) return;
      try {
        Quagga.offDetected(this._handleDetected.bind(this)); // 念のため
      } catch (e) {}
      try { Quagga.stop(); } catch (e2) {}
      this._running = false;
      this._lastCode = null;
      this._lastTs = 0;
      this._hitCount = 0;
    },

    setScanMode: function (isOn) {
      // app側主導でもOK。ここは将来拡張用。
      return isOn;
    },

    _emit: function (payload) {
      if (typeof this._onDetected === 'function') {
        this._onDetected(payload);
      }
    },

    _handleDetected: function (result) {
      if (!result || !result.codeResult || !result.codeResult.code) return;

      var rawCode = stripNonPrintable(result.codeResult.code);
      var sym = result.codeResult.format || '';

      // 正規化：数字のみ（ean系）、code128はそのまま
      var digits = rawCode.replace(/\D/g, '');

      var payload = {
        raw: rawCode,
        symbology: sym,
        jan13: null,
        gtin14: null,
        ai01: null,
        ts: nowMs()
      };

      // EAN-13
      if (digits.length === 13) {
        payload.jan13 = digits;
      }

      // GS1-128(Code128) -> AI(01) GTIN14
      var gtin14 = extractGTIN14FromGS1(rawCode);
      if (gtin14 && gtin14.length === 14) {
        payload.gtin14 = gtin14;
        payload.ai01 = gtin14;
        // 先頭0ならJAN13に落とせる
        if (gtin14.charAt(0) === '0') {
          payload.jan13 = gtin14.substring(1);
        }
      }

      // check digit
      if (this._opts && this._opts.checkDigit) {
        if (payload.jan13 && !eanMod10Valid(payload.jan13)) return;
        if (payload.gtin14 && !eanMod10Valid(payload.gtin14)) return;
      }

      // double-hit（同一コードが短時間に2回）
      var key = payload.jan13 ? ('J:' + payload.jan13) : (payload.gtin14 ? ('G:' + payload.gtin14) : ('R:' + payload.raw));
      var t = payload.ts;

      var windowMs = (this._opts && this._opts.doubleHitWindowMs != null) ? this._opts.doubleHitWindowMs : 900;
      var needHits = (this._opts && this._opts.needHits != null) ? this._opts.needHits : (this._opts && this._opts.doubleHit ? 2 : 1);

      if (this._lastCode === key && (t - this._lastTs) <= windowMs) {
        this._hitCount += 1;
      } else {
        this._lastCode = key;
        this._lastTs = t;
        this._hitCount = 1;
      }

      if (this._hitCount >= needHits) {
        // 連続発火を少し抑制
        this._lastTs = t + 250;
        this._emit(payload);
      }
    }
  };

  window.Scanner = Scanner;
})();
