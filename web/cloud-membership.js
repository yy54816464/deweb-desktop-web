/* DeWEB Desktop · membership wallet cloud sync UI */
(function () {
  'use strict';
  var CIRCUIT_RESOLVER = '0xd86fBB4Db54FCc2F5Be19F699b020d614998f59f';
  var IS_PRO_SELECTOR = '0x41b99a80';
  var XLAYER_RPCS = ['https://rpc.xlayer.tech', 'https://xlayer.drpc.org', 'https://196.rpc.thirdweb.com/'];
  // Pin the cloud API. Neither localStorage nor a page global may redirect
  // nonce/verify/logout and capture signatures.
  var API = 'https://api.dewebdesk.link';
  try { var apiOrigin = new URL(API); if (apiOrigin.protocol !== 'https:') throw new Error('bad api'); API = apiOrigin.origin; } catch(e) { API = 'https://api.dewebdesk.link'; }
  var TOKEN_KEY = 'deweb.cloud.membership.token.v1';
  var EXPLICIT_LOGOUT_KEY = 'deweb.cloud.explicit-logout';
  var ALPHA_FREE_UNTIL = Date.parse('2026-12-31T15:59:59Z');
  function alphaFree(){ return Date.now() < ALPHA_FREE_UNTIL; }
  var token = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch(e) {}
  var lastMembership = null;
  var busy = false;
  var cloudRevision = 0;
  var cloudAddress = '';
  var applyingCloud = false;
  var pushTimer = null;

  function tokenPayload(){
    try {
      var p = String(token || '').split('.')[0];
      if (!p) return null;
      p = p.replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch(e) { return null; }
  }
  (function(){ var pl = tokenPayload(); if (pl && pl.sub) cloudAddress = String(pl.sub).toLowerCase(); })();
  function liveAccount(){
    try { if (window.__dewebWalletDisconnected) return ''; } catch(e) {}
    try { if (window.__dewebLiveWalletAddress) return String(window.__dewebLiveWalletAddress).toLowerCase(); } catch(e) {}
    try { if (typeof walletAccount !== 'undefined' && walletAccount) return String(walletAccount).toLowerCase(); } catch(e) {}
    try { if (window.ethereum && window.ethereum.selectedAddress) return String(window.ethereum.selectedAddress).toLowerCase(); } catch(e) {}
    return '';
  }
  function sameAccount(){
    var a = liveAccount();
    return !!a && !!cloudAddress && a === cloudAddress;
  }

  function langEn(){ return typeof lang !== 'undefined' && lang === 'en'; }
  function L(zh, en){ return langEn() ? en : zh; }
  function short(a){ return a ? a.slice(0, 6) + '…' + a.slice(-4) : ''; }
  function status(text, bad){
    var el = document.getElementById('cmStatus');
    if (el){ el.textContent = text || ''; el.style.color = bad ? 'var(--err)' : 'var(--signal)'; }
  }
  function account(){
    try { if (window.__dewebCloudAddress) return window.__dewebCloudAddress; } catch(e) {}
    try { if (typeof walletAccount !== 'undefined' && walletAccount) return walletAccount; } catch(e) {}
    return '';
  }
  function provider(){
    try { if (typeof ethProvider === 'function') return ethProvider(); } catch(e) {}
    return window.ethereum || null;
  }
  function apiUrl(p){
    var base = API.replace(/\/+$/, '');
    if (!/\/api$/.test(base)) base += '/api';
    return base + p;
  }
  var nativeWaiters = {};
  window.__dewebCloudAuthResult = function(id, address, signature, error){
    var w = nativeWaiters[id];
    // A late callback after a timeout must not change the live wallet.
    if (!w) return;
    delete nativeWaiters[id];
    if (address) {
      window.__dewebLiveWalletAddress = String(address).toLowerCase();
      window.__dewebWalletDisconnected = false;
    }
    if (error) w.reject(new Error(error));
    else w.resolve({ address: address || '', signature: signature || '' });
  };
  function nativeAvailable(){ return !!(window.dewebCloudAuth && typeof window.dewebCloudAuth.connect === 'function'); }
  function nativeCall(kind, message, timeoutMs){
    return new Promise(function(resolve, reject){
      if (!nativeAvailable()) { reject(new Error('Android wallet bridge unavailable')); return; }
      var id = 'cloud-' + kind + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var timer = setTimeout(function(){
        if (nativeWaiters[id]) {
          delete nativeWaiters[id];
          reject(new Error('钱包响应超时'));
        }
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 300000);
      nativeWaiters[id] = {
        resolve: function(v){ clearTimeout(timer); resolve(v); },
        reject: function(e){ clearTimeout(timer); reject(e); }
      };
      try {
        if (kind === 'sign') window.dewebCloudAuth.sign(id, message || '');
        else if (kind === 'disconnect') window.dewebCloudAuth.disconnect(id);
        else window.dewebCloudAuth.connect(id);
      } catch(e) { clearTimeout(timer); delete nativeWaiters[id]; reject(e); }
    });
  }
  async function jpost(p, body){
    var r = await fetch(apiUrl(p), { method:'POST', credentials:'include', headers:(function(){ var h={'Content-Type':'application/json'}; if (token && token !== 'cookie') h.Authorization='Bearer '+token; return h; })(), body:JSON.stringify(body) });
    var t = await r.text(); var j = null;
    try { j = t ? JSON.parse(t) : null; } catch(e) { j = t; }
    if (r.status === 401 && token === 'cookie') { expireCloudSession(); }
    if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
    return j;
  }
  async function jget(p){
    var r = await fetch(apiUrl(p), { credentials:'include', headers:(token && token !== 'cookie' ? {'Authorization':'Bearer ' + token} : {}) });
    var t = await r.text(); var j = null;
    try { j = t ? JSON.parse(t) : null; } catch(e) { j = t; }
    if (r.status === 401 && token === 'cookie') { expireCloudSession(); }
    if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
    return j;
  }
  var PROFILE_SESSION_KEY = 'deweb.cloud.profile.key.v1';
  var PROFILE_SESSION_SALT = 'deweb.cloud.profile.salt.v1';
  var profileKey = null;
  var profileSalt = '';
  var profileIterations = 210000;
  var profileUnlocked = false;
  var fileSecretKey = null;
  var fileMasterSecret = null;
  var fileMasterKeyB64 = '';
  var pendingWalls = {};
  var wallSeq = {desktop:0, mobile:0};
  var profileEpoch = 0;
  var signingOut = false;
  var WALL_DIRTY_PREFIX = 'deweb.cloud.wall.dirty.';
  var activePush = null;
  var syncing = false;
  var syncQueued = false;
  function wallDirtyOwner(){
    try { return String(liveAccount() || cloudAddress || 'guest'); } catch(e) { return 'guest'; }
  }
  function wallDirtyKey(mode, owner){
    return WALL_DIRTY_PREFIX + String(owner || wallDirtyOwner()) + '.' + mode;
  }
  // A cheap fingerprint of the local image. The wallpaper IDB is device-wide,
  // so the dirty flag alone is not enough: B may have replaced the image while
  // A's dirty marker is still set. Only push when the bytes still match.
  function wallFingerprint(data){
    var s = String(data || '');
    return s.length + ':' + s.slice(0, 96) + ':' + s.slice(-96);
  }
  function wallDirty(mode){
    try {
      var v = localStorage.getItem(wallDirtyKey(mode));
      return !!v && v.indexOf('1') === 0;
    } catch(e) { return false; }
  }
  function wallDirtyMatches(mode, data){
    try {
      var v = localStorage.getItem(wallDirtyKey(mode));
      return !!v && v.indexOf('1|') === 0 && v.slice(2) === wallFingerprint(data);
    } catch(e) { return false; }
  }
  function setWallDirty(mode, dirty, owner, data){
    try {
      var k = wallDirtyKey(mode, owner);
      if (dirty) localStorage.setItem(k, '1|' + wallFingerprint(data));
      else localStorage.removeItem(k);
    } catch(e) {}
  }
  function toB64(buf){
    var bytes = new Uint8Array(buf); var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(s){
    var bin = atob(String(s || '')); var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Encode(s){ return new TextEncoder().encode(String(s)); }
  function utf8Decode(b){ return new TextDecoder().decode(b); }
  async function importProfileKey(rawB64){
    return await crypto.subtle.importKey('raw', fromB64(rawB64), {name:'AES-GCM'}, true, ['encrypt','decrypt']);
  }
  async function rememberProfileKey(){
    // 不把 raw profileKey 写入浏览器存储。刷新/重启后重新输入密码。
    try { sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch(e) {}
  }
  async function restoreProfileKey(){
    try { sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch(e) {}
  }
  function kdfIterations(n){ return Math.max(100000, Math.min(500000, Number(n) || 210000)); }
  async function deriveProfileKey(password, saltB64, iterations){
    var base = await crypto.subtle.importKey('raw', utf8Encode(password), 'PBKDF2', false, ['deriveKey']);
    var n = kdfIterations(iterations);
    return await crypto.subtle.deriveKey({
      name:'PBKDF2', salt:fromB64(saltB64), iterations:n, hash:'SHA-256'
    }, base, {name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
  }
  var PROFILE_AAD_V2 = 'deweb-profile-aad-v2';
  async function encryptProfile(data){
    if (!profileKey) throw new Error('云同步密码未解锁');
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({name:'AES-GCM', iv:iv, additionalData:utf8Encode(PROFILE_AAD_V2)}, profileKey, utf8Encode(JSON.stringify(data)));
    return {enc:2, kdf:'PBKDF2-SHA256', iterations:kdfIterations(profileIterations), salt:profileSalt, iv:toB64(iv), ciphertext:toB64(ct)};
  }
  async function decryptProfile(envelope, key){
    var k = key || profileKey;
    if (!k) throw new Error('云同步密码未解锁');
    if (!envelope || (envelope.enc !== 1 && envelope.enc !== 2)) throw new Error('不是加密数据');
    var opts = {name:'AES-GCM', iv:fromB64(envelope.iv)};
    if (envelope.enc === 2) opts.additionalData = utf8Encode(PROFILE_AAD_V2);
    var pt = await crypto.subtle.decrypt(opts, k, fromB64(envelope.ciphertext));
    return JSON.parse(utf8Decode(new Uint8Array(pt)));
  }
  var WALL_AAD = 'deweb-wallpaper-v1';
  async function deriveWallKey(){
    if (!profileKey) throw new Error('云同步密码未解锁');
    var raw = await crypto.subtle.exportKey('raw', profileKey);
    var base = await crypto.subtle.importKey('raw', raw, {name:'HKDF'}, false, ['deriveKey']);
    return await crypto.subtle.deriveKey({
      name:'HKDF', hash:'SHA-256',
      salt:utf8Encode('deweb-wallpaper-key-v1'),
      info:utf8Encode(WALL_AAD)
    }, base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
  }
  async function deriveFileSecret(){
    if (!profileKey) throw new Error('云同步密码未解锁');
    if (fileSecretKey) return fileSecretKey;
    var raw = await crypto.subtle.exportKey('raw', profileKey);
    var base = await crypto.subtle.importKey('raw', raw, {name:'HKDF'}, false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({
      name:'HKDF', hash:'SHA-256',
      salt:utf8Encode('deweb-taperelay-file-salt-v1'),
      info:utf8Encode('deweb-taperelay-x25519-v1')
    }, base, 256);
    fileSecretKey = new Uint8Array(bits);
    return fileSecretKey;
  }
  function ensureMasterKey(){
    if (fileMasterSecret) return fileMasterSecret;
    if (fileMasterKeyB64) {
      try { fileMasterSecret = fromB64(fileMasterKeyB64); } catch(e) { fileMasterSecret = null; fileMasterKeyB64 = ''; }
    }
    if (!fileMasterSecret || fileMasterSecret.length !== 32) {
      fileMasterSecret = crypto.getRandomValues(new Uint8Array(32));
      fileMasterKeyB64 = toB64(fileMasterSecret);
    }
    return fileMasterSecret;
  }
  async function unlockRemoteProfile(remote){
    if (!remote || !remote.tape || profileKey) return true;
    if (!remote.kdf || !remote.kdf.salt) throw new Error(L('云端数据缺少 KDF 信息，无法解锁。请重置云同步。','Cloud data has no KDF information and cannot be unlocked. Reset cloud sync.'));
    var pwd = await askPassword('unlock');
    if (!pwd) return false;
    profileIterations = kdfIterations(remote.kdf.iterations);
    var key = await deriveProfileKey(pwd, remote.kdf.salt, profileIterations);
    profileKey = key;
    profileSalt = String(remote.kdf.salt);
    fileSecretKey = null;
    await deriveFileSecret();
    try {
      var check = await hydrateRemote(remote);
      if (!check || !check.data) throw new Error('empty profile');
      if ((check.data.enc === 1 || check.data.enc === 2)) await decryptProfile(check.data, key);
    } catch (e) {
      profileKey = null; profileSalt = ''; profileIterations = 210000; fileSecretKey = null;
      try { sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch (_) {}
      throw new Error(L('云同步密码错误，或云端数据读取失败。请重试。','Cloud password incorrect, or cloud data could not be read. Retry.'));
    }
    await rememberProfileKey();
    return true;
  }
  function wallAadV2(mode){ return WALL_AAD + ':v2:' + (mode === 'mobile' ? 'mobile' : 'desktop'); }
  async function encryptWall(blob, mode){
    var key = await deriveWallKey();
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({name:'AES-GCM', iv:iv, additionalData:utf8Encode(wallAadV2(mode))}, key, await blob.arrayBuffer());
    return { ct: ct, iv: toB64(iv) };
  }
  async function decryptWallBytes(ct, ivB64, mime, mode, aadVersion){
    if (!/^image\/(jpeg|png|webp)$/i.test(mime || '')) throw new Error('壁纸类型无效');
    var key = await deriveWallKey();
    var v2 = {name:'AES-GCM', iv:fromB64(ivB64), additionalData:utf8Encode(wallAadV2(mode))};
    if (aadVersion === 'v2') return new Blob([await crypto.subtle.decrypt(v2, key, ct)], {type:mime});
    try { return new Blob([await crypto.subtle.decrypt(v2, key, ct)], {type:mime}); }
    catch (e) { return new Blob([await crypto.subtle.decrypt({name:'AES-GCM', iv:fromB64(ivB64), additionalData:utf8Encode(WALL_AAD)}, key, ct)], {type:mime}); }
  }
  async function decryptWallResponse(r){
    var ivB64 = r.headers.get('X-Wall-IV') || '';
    var mime = r.headers.get('X-Wall-Mime') || 'image/jpeg';
    if (!/^image\/(jpeg|png|webp)$/i.test(mime)) throw new Error('壁纸类型无效');
    var key = await deriveWallKey();
    var ct = await r.arrayBuffer();
    var pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:fromB64(ivB64), additionalData:utf8Encode(WALL_AAD)}, key, ct);
    return new Blob([pt], {type:mime});
  }
  function askPassword(mode){
    return new Promise(function(resolve){
      var mask = document.createElement('div'); mask.className='mask on'; mask.style.zIndex='2147483647';
      var modal = document.createElement('div'); modal.className='modal'; modal.style.maxWidth='400px';
      var hd = document.createElement('div'); hd.className='hd';
      hd.appendChild(document.createElement('span')).textContent = mode === 'set' ? '设置云同步密码' : '解锁云端数据';
      var close = document.createElement('span'); close.textContent='✕'; close.style.cursor='pointer';
      close.onclick = function(){ mask.remove(); resolve(null); }; hd.appendChild(close); modal.appendChild(hd);
      var bd = document.createElement('div'); bd.className='bd';
      var note = document.createElement('div'); note.className='cm-note';
      note.textContent = mode === 'set'
        ? '密码只在本机用于加密/解密，服务器看不到。至少 8 位。请务必自行备份：忘记后云端数据无法恢复，没有后台找回。'
        : '输入云同步密码解锁。密码不会发送到服务器。';
      bd.appendChild(note);
      var input = document.createElement('input'); input.type='password'; input.autocomplete='new-password';
      input.placeholder='云同步密码'; input.style.cssText='width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid var(--trace);background:var(--board);color:var(--silk);font:12px var(--mono);';
      bd.appendChild(input);
      var input2 = null;
      if (mode === 'set') {
        input2 = document.createElement('input'); input2.type='password'; input2.autocomplete='new-password';
        input2.placeholder='再次输入密码'; input2.style.cssText=input.style.cssText;
        bd.appendChild(input2);
      }
      var err = document.createElement('div'); err.style.cssText='font:10px/1.6 var(--mono);color:var(--err);min-height:14px;'; bd.appendChild(err);
      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;align-items:center;gap:18px;margin-top:14px;';
      var passBtnCss = 'min-width:108px;height:44px;padding:0 22px;border-radius:999px;border:1px solid rgba(255,255,255,.78);background:linear-gradient(180deg,rgba(255,255,255,.92),rgba(255,255,255,.46));backdrop-filter:blur(20px) saturate(150%);box-shadow:0 10px 24px rgba(20,40,30,.18),inset 0 1px 0 rgba(255,255,255,.98);color:#10231a;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;';
      var cancel = document.createElement('button'); cancel.textContent='取消'; cancel.style.cssText=passBtnCss;
      var ok = document.createElement('button'); ok.textContent='确认'; ok.style.cssText=passBtnCss + 'background:linear-gradient(180deg,rgba(205,255,232,.96),rgba(105,226,176,.74));border-color:rgba(110,235,184,.95);';
      actions.appendChild(cancel);
      actions.appendChild(ok); bd.appendChild(actions);
      modal.appendChild(bd); mask.appendChild(modal); document.body.appendChild(mask);
      setTimeout(function(){ try{input.focus();}catch(e){} }, 50);
      cancel.onclick = function(){ mask.remove(); resolve(null); };
      function submit(){
        var v = input.value || '';
        if (!v) { err.textContent='请输入密码'; return; }
        if (mode === 'set') {
          if (v.length < 8) { err.textContent='密码至少 8 位'; return; }
          if (v !== (input2.value || '')) { err.textContent='两次密码不一致'; return; }
        }
        mask.remove(); resolve(v);
      }
      ok.onclick = submit;
      input.onkeydown = function(e){ if (e.key === 'Enter') submit(); };
      if (input2) input2.onkeydown = function(e){ if (e.key === 'Enter') submit(); };
    });
  }
  async function ensureProfileKey(remoteData){
    if (profileKey) return true;
    if (remoteData && (remoteData.enc === 1 || remoteData.enc === 2)) {
      var pwd = await askPassword('unlock');
      if (!pwd) return false;
      profileIterations = kdfIterations(remoteData.iterations);
      var key = await deriveProfileKey(pwd, remoteData.salt, profileIterations);
      await decryptProfile(remoteData, key);
      profileKey = key; profileSalt = String(remoteData.salt || '');
      await rememberProfileKey();
      await deriveFileSecret();
      return true;
    }
    var pwd2 = await askPassword('set');
    if (!pwd2) return false;
    profileIterations = 210000;
    profileSalt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    profileKey = await deriveProfileKey(pwd2, profileSalt, profileIterations);
    await rememberProfileKey();
    await deriveFileSecret();
    return true;
  }
  async function decodeRemoteProfile(data){
    if (!data) return null;
    if (data.enc !== 1 && data.enc !== 2) return data;
    return await decryptProfile(data);
  }
  async function hydrateRemote(remote){
    if (remote && remote.tape && remote.tape.manifest && window.DeWEBTapeDirect && token) {
      var lastErr = null;
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          var fsk = profileKey ? await deriveFileSecret() : null;
          remote.data = await window.DeWEBTapeDirect.readProfile(remote.tape.manifest, token, fsk);
          return remote;
        } catch(e) {
          if (isTape401(e)) { expireCloudSession(); throw new Error('云同步登录已过期，请重新登录'); }
          lastErr = e;
          if (attempt === 0) await new Promise(function(r){ setTimeout(r, 500); });
        }
      }
      throw new Error('TapeRelay profile 直读失败，Worker 文件代理已禁用：' + (lastErr && lastErr.message ? lastErr.message : lastErr));
    }
    return remote;
  }

  function expiryText(exp){
    if (!exp) return L('未开通 / 未检测', 'Not active');
    var d = new Date(exp * 1000);
    if (isNaN(d.getTime())) return L('未知', 'Unknown');
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }
  var lastQuota = null;
  function fmtSize(bytes){
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function setQuota(q){
    if (!q) return;
    lastQuota = q;
    var el = document.getElementById('cmQuota');
    if (el) el.textContent = fmtSize(q.used || 0) + ' / ' + fmtSize(q.limit || 0);
    try { refreshPro(); } catch(e) {}
  }
  function padAddr(a){
    return a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  }
  async function readPro(rpcs, contract, addr){
    var data = IS_PRO_SELECTOR + padAddr(addr);
    var results = await Promise.all(rpcs.map(async function(rpc){
      var ctl = new AbortController();
      var timer = setTimeout(function(){ ctl.abort(); }, 2500);
      try {
        var r = await fetch(rpc, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:contract,data:data},'latest']}),
          signal: ctl.signal
        });
        var j = await r.json();
        if (!j || typeof j.result !== 'string' || j.result === '0x') return null;
        return BigInt(j.result) !== 0n;
      } catch(e) { return null; }
      finally { clearTimeout(timer); }
    }));
    if (results.some(function(x){ return x === true; })) return true;
    if (results.some(function(x){ return x === false; })) return false;
    return null;
  }
  async function fetchMembership(addr){
    if (!addr) return null;
    var circuit = await readPro(XLAYER_RPCS, CIRCUIT_RESOLVER, addr);
    if (circuit) return { active: true, source: 'circuit', lifetime: false };
    if (alphaFree()) return { active: true, source: 'alpha', alpha: true, alphaUntil: ALPHA_FREE_UNTIL };
    if (circuit === null) return null;
    return { active: false, source: 'none', lifetime: false };
  }
  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  async function signOutCloud(disconnectWalletToo){
    if (signingOut) return;
    signingOut = true;
    try {
      try { localStorage.setItem(EXPLICIT_LOGOUT_KEY, '1'); } catch(e) {}
      profileEpoch++;
      var hadSession = !!token;
      token = ''; cloudAddress = ''; cloudRevision = 0; window.__dewebCloudAddress = ''; lastMembership = null;
      // Drop the live wallet pointer even if the provider/wallet never answers.
      window.__dewebLiveWalletAddress = '';
      profileKey = null; profileSalt = ''; profileIterations = 210000; profileUnlocked = false;
      fileSecretKey = null; fileMasterSecret = null; fileMasterKeyB64 = ''; pendingWalls = {};
      try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch(e) {}
      try { window.dispatchEvent(new Event('deweb-cloud-disconnected')); } catch(e) {}
      refresh();
      // Disconnect the wallet/native session BEFORE the server logout. If the
      // logout hangs (offline, Worker stall), the user must still see the
      // wallet disconnected locally.
      if (disconnectWalletToo) {
        // The native wallet page keeps its OKX/WalletConnect session cache.
        // Ask the app to reset it before the next connect; otherwise the next
        // sign-in silently reuses the previous account.
        if (nativeAvailable() && typeof window.dewebCloudAuth.disconnect === 'function') {
          try { await nativeCall('disconnect', '', 1500); } catch(e) {}
        }
        if (typeof window.disconnectWallet === 'function') {
          try { await window.disconnectWallet(); } catch(e) {}
        }
      }
      if (hadSession) {
        // Best-effort server logout, bounded so signingOut never stays stuck.
        try {
          await Promise.race([
            jpost('/auth/logout', {}).catch(function(){}),
            new Promise(function(resolve){ setTimeout(resolve, 2500); })
          ]);
        } catch(e) {}
      }
    } finally {
      signingOut = false;
      try { refresh(); } catch(e) {}
    }
  }
  function build(){
    if (document.getElementById('cmMask')) return;
    var style = document.createElement('style');
    style.textContent = '#cmMask .modal{max-width:480px}#cmMask .bd{display:flex;flex-direction:column;gap:10px;max-height:72vh;overflow:auto}#cmMask .cm-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--trace);padding:6px 0;font:11px/1.6 var(--mono);color:var(--dim)}#cmMask .cm-row b{color:var(--silk);font-weight:500;text-align:right;word-break:break-all}#cmMask .cm-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}#cmMask .cm-note{font-size:10px;line-height:1.8;color:var(--dim);border:1px solid var(--trace);background:var(--board);padding:9px;border-radius:10px}#cmMask .cm-warn{color:var(--err)}#cmMask .cm-btn{border:1px solid rgba(224,255,242,.20);border-radius:999px;background:rgba(255,255,255,.08);color:var(--silk);padding:7px 11px;font:11px var(--sans);cursor:pointer}#cmMask .cm-btn:hover{border-color:var(--signal);color:#d8fff0}#cmMask .cm-btn[disabled]{opacity:.45;cursor:not-allowed}';
    document.head.appendChild(style);
    var mask = el('div', 'mask'); mask.id = 'cmMask';
    var modal = el('div', 'modal');
    var hd = el('div', 'hd'); hd.appendChild(el('span', null, L('会员云同步', 'MEMBER CLOUD')));
    var close = el('span', null, '✕'); close.style.cursor = 'pointer'; close.id = 'cmClose'; hd.appendChild(close);
    modal.appendChild(hd);
    var bd = el('div', 'bd');
    function row(label, id){ var r = el('div','cm-row'); r.appendChild(el('span',null,label)); var b = el('b',null,'—'); b.id = id; r.appendChild(b); bd.appendChild(r); return b; }
    row(L('钱包地址','WALLET'), 'cmAddr');
    row(L('会员到期','MEMBERSHIP'), 'cmExpiry');
    row(L('云端状态','CLOUD'), 'cmCloud');
    row(L('云空间','STORAGE'), 'cmQuota');
    var note = el('div','cm-note'); note.id = 'cmNote'; note.textContent = L('本地优先。会员云同步用于在新设备恢复已添加的站点、文件夹、桌面位置和壁纸。云同步密码请自行备份，丢失无法找回。','Local-first. Member cloud sync restores sites, folders, positions and wallpapers on a new device.'); bd.appendChild(note);
    var st = el('div','cm-note'); st.id = 'cmStatus'; st.style.minHeight='18px'; bd.appendChild(st);
    var actions = el('div','cm-actions');
    var btnConnect = el('button','cm-btn', L('连接钱包','CONNECT WALLET')); btnConnect.id='cmConnect'; actions.appendChild(btnConnect);
    var btnLogin = el('button','cm-btn', L('登录云同步','SIGN IN')); btnLogin.id='cmLogin'; actions.appendChild(btnLogin);
    var btnSync = el('button','cm-btn', L('立即同步','SYNC NOW')); btnSync.id='cmSync'; actions.appendChild(btnSync);
    var btnReset = el('button','cm-btn', L('忘记密码 / 重置云同步','FORGOT PASSWORD / RESET')); btnReset.id='cmReset'; actions.appendChild(btnReset);
    var btnOut = el('button','cm-btn', L('退出云端','SIGN OUT')); btnOut.id='cmOut'; actions.appendChild(btnOut);
    bd.appendChild(actions);
    modal.appendChild(bd);
    var ft = el('div','ft'); var done = el('button','btn', L('完成','DONE')); done.id='cmDone'; ft.appendChild(done); modal.appendChild(ft);
    mask.appendChild(modal); document.body.appendChild(mask);
    close.onclick = done.onclick = function(){ mask.classList.remove('on'); };
    mask.addEventListener('click', function(e){ if (e.target === mask) mask.classList.remove('on'); });
    btnConnect.onclick = function(){
      if (account()) { refresh(); return; }
      if (nativeAvailable()) {
        busy = true; status(L('正在打开钱包…','Opening wallet…'));
        nativeCall('connect', '').then(function(r){ window.__dewebLiveWalletAddress = String(r.address || '').toLowerCase(); window.__dewebWalletDisconnected = false; if (cloudAddress && window.__dewebLiveWalletAddress && window.__dewebLiveWalletAddress !== cloudAddress) signOutCloud(); busy = false; status(L('钱包已连接','Wallet connected')); refresh(); }).catch(function(e){ busy = false; status(L('连接失败：','Connect failed: ') + (e && e.message ? e.message : e), true); });
        return;
      }
      if (typeof connectWallet === 'function') connectWallet(); else status(L('当前环境没有钱包','Wallet unavailable'), true);
    };
    btnOut.onclick = function(){ signOutCloud(true); };
    btnLogin.onclick = signIn;
    var btnReset = document.getElementById('cmReset'); if (btnReset) btnReset.onclick = resetCloud;
    btnSync.onclick = syncNow;
  }
  function refreshButtons(){
    var a = account();
    var c = document.getElementById('cmConnect');
    if (c) { c.textContent = a ? L('刷新会员状态','REFRESH') : L('连接钱包','CONNECT WALLET'); c.style.display = a ? '' : 'none'; }
    var b = document.getElementById('cmLogin');
    if (b) { var needAuth = !a || (!!token && !!cloudAddress && a.toLowerCase() !== String(cloudAddress).toLowerCase()); b.textContent = token ? L('登录云同步','SIGN IN') : (a ? L('登录云同步','SIGN IN') : L('连接并登录','CONNECT & SIGN IN')); b.disabled = !API || (!!token && !needAuth); }
    document.getElementById('cmSync').disabled = !API || !token;
    document.getElementById('cmOut').disabled = !token;
  }
  function cloudHostSupported(){
    return location.hostname === 'app.dewebdesk.link';
  }
  async function refresh(){
    build();
    if (!cloudHostSupported()) {
      document.getElementById('cmCloud').textContent = L('当前入口不支持云同步','Cloud sync unsupported on this host');
      document.getElementById('cmNote').textContent = L('云同步使用 HttpOnly Cookie，仅支持 https://app.dewebdesk.link 同站入口。经 tapekit/tapeout 等网关打开时，浏览器不会发送跨站 Cookie。','Cloud sync uses an HttpOnly cookie and is supported only at https://app.dewebdesk.link. Gateway hosts cannot send the cross-site cookie.');
      ['cmConnect','cmLogin','cmSync','cmReset','cmOut'].forEach(function(id){ var b=document.getElementById(id); if(b) b.disabled=true; });
      status(L('请用 app.dewebdesk.link 打开以使用云同步','Open app.dewebdesk.link for cloud sync'), true);
      refreshPro();
      return;
    }
    var live = liveAccount();
    var a = live || '';
    document.getElementById('cmAddr').textContent = a ? (a.slice(0,10)+'…'+a.slice(-6)) : L('未连接','Not connected');
    if (token && cloudAddress && !live) {
      try { status(L('钱包未连接，请先连接钱包','Connect a wallet first'), true); } catch(e) {}
    }
    document.getElementById('cmCloud').textContent = API ? (token ? (profileKey ? L('已登录 · 已解锁','Signed in · unlocked') : L('已登录 · 待解锁','Signed in · locked')) : L('未登录','Not signed in')) : L('服务未配置','Not configured');
    document.getElementById('cmNote').textContent = API
      ? L('会员云同步会把已添加的站点、文件夹、桌面位置和壁纸保存到云端。站点、布局和壁纸均使用云同步密码端到端加密，服务端只保存密文。不包含私钥/助记词。','Member cloud sync saves sites, folders, positions and wallpapers to the cloud. Sites, layouts and wallpapers are end-to-end encrypted with your cloud password; the server stores ciphertext only. Back up this password yourself: losing it means the cloud data cannot be recovered. Private keys/seed phrases are never included.')
      : L('云同步服务尚未配置；当前仅显示本地钱包和会员状态。','Cloud sync is not configured yet; showing local wallet and membership status only.');
    refreshButtons();
    if (!a) { document.getElementById('cmExpiry').textContent = L('未连接','—'); refreshPro(); return; }
    document.getElementById('cmExpiry').textContent = L('查询中…','Checking…');
    var exp = await fetchMembership(a);
    lastMembership = exp;
    if (exp === null) document.getElementById('cmExpiry').textContent = L('RPC 不可用','RPC unavailable');
    else if (!exp || !exp.active) document.getElementById('cmExpiry').textContent = L('未开通','Not active');
    else document.getElementById('cmExpiry').textContent = (exp && exp.source === 'circuit') ? L('电路会员','Circuit Pro') : ((exp && exp.alpha) ? L('Alpha 测试期免费 Pro · 至 2026-12-31','Alpha free Pro · until 2026-12-31') : L('Pro 已激活','Pro active'));
    refreshButtons();
    refreshPro();
  }
  async function restoreSession(){
    if (!cloudHostSupported()) return;
    // An explicit sign-out must not be undone by a still-valid server cookie
    // when the best-effort logout failed.
    try { if (localStorage.getItem(EXPLICIT_LOGOUT_KEY) === '1') return; } catch(e) {}
    try {
      var r = await fetch(apiUrl('/auth/session'), { credentials:'include', cache:'no-store' });
      if (!r.ok) return;
      var j = await r.json();
      if (j && j.ok && j.address) {
        token = 'cookie';
        cloudAddress = String(j.address).toLowerCase();
        window.__dewebCloudAddress = cloudAddress;
        refresh();
      }
    } catch(e) {}
  }
  async function authenticate(){
    if (!API) throw new Error(L('云同步服务尚未接入','Cloud service is not configured'));
    busy = true; status(L('请求登录挑战…','Requesting challenge…')); refreshButtons();
    try {
      var a = liveAccount();
      if (!a && nativeAvailable()) {
        status(L('正在打开钱包…','Opening wallet…'));
        try { a = (await nativeCall('connect', '')).address; } catch(e) {}
        if (a) { window.__dewebLiveWalletAddress = String(a).toLowerCase(); window.__dewebWalletDisconnected = false; }
      }
      if (!a && typeof connectWallet === 'function') {
        status(L('正在连接钱包…','Connecting wallet…'));
        try { await connectWallet(); } catch(e) {}
        try { closeWalletModal(); } catch(e) {}
        a = liveAccount();
      }
      if (!a) throw new Error(L('请先连接钱包','Connect wallet first'));
      if (cloudAddress && String(cloudAddress).toLowerCase() !== String(a).toLowerCase()) { await signOutCloud(); }
      if (nativeAvailable() && a) window.__dewebLiveWalletAddress = String(a).toLowerCase(); window.__dewebWalletDisconnected = false;
      var nonce = await jpost('/auth/nonce', {address:a});
      var msg = nonce.message || ('DeWEB Cloud Sync\nAddress: ' + a + '\nNonce: ' + (nonce.nonce || '') + '\nChain: BSC');
      var sig;
      if (nativeAvailable()) {
        status(L('请在钱包中签名…','Confirm signature in wallet…'));
        var signed = await nativeCall('sign', msg);
        if (signed.address) { a = signed.address; window.__dewebLiveWalletAddress = String(a).toLowerCase(); window.__dewebWalletDisconnected = false; }
        sig = signed.signature;
      } else {
        var p = provider();
        if (!p || typeof p.request !== 'function') throw new Error(L('当前环境没有签名钱包','No signing wallet'));
        sig = await p.request({method:'personal_sign', params:[msg, a]});
      }
      var v = await jpost('/auth/verify', {address:a, nonce:nonce.nonce, signature:sig});
      token = 'cookie';
      cloudAddress = a.toLowerCase();
      window.__dewebCloudAddress = cloudAddress;
      try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(EXPLICIT_LOGOUT_KEY); } catch(e) {}
      return true;
    } finally { busy = false; refreshButtons(); }
  }
  async function signIn(){
    try {
      if (!await authenticate()) return;
      status(L('云端登录成功，正在同步…','Signed in, syncing…'));
      await syncNow();
    } catch(e) { status(L('登录失败：','Sign-in failed: ') + (e && e.message ? e.message : e), true); }
    refresh();
  }
  async function resetCloud(){
    if (busy) return;
    if (!API) { status(L('云同步服务尚未接入','Cloud service is not configured'), true); return; }
    try {
      if (!token) { if (!await authenticate()) return; }
      if (!liveAccount()) { status(L('请先连接钱包','Connect a wallet first'), true); return; }
      if (!sameAccount()) { status(L('钱包与云端账号不一致，请先退出云端重新登录','Wallet does not match cloud account; sign out and sign in first'), true); return; }
    } catch (e) { status(L('登录失败：','Sign-in failed: ') + (e && e.message ? e.message : e), true); return; }
    if (!window.confirm(L('重置云同步会永久删除云端旧数据，无法恢复。\n\n本机数据会保留，重置后需重新设置密码并上传。\n\n确定继续？','Resetting cloud sync permanently deletes old cloud data and cannot be undone. Local data stays. Continue?'))) return;
    if (!window.confirm(L('再次确认：旧云端站点、布局和壁纸将永久丢失。\n\n确定重置？','Confirm again: old cloud sites, layouts and wallpapers will be permanently lost. Reset?'))) return;
    try {
      busy = true; status(L('正在重置云端…','Resetting cloud…')); refreshButtons();
      // Let an in-flight push settle before deleting pointers; then bump the
      // epoch so anything still running cannot write after the reset.
      try { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } } catch(e) {}
      if (activePush) {
        try {
          await Promise.race([
            activePush.catch(function(){}),
            new Promise(function(r){ setTimeout(r, 8000); })
          ]);
        } catch(e) {}
      }
      profileEpoch++;
      wallSeq.desktop++;
      wallSeq.mobile++;
      await jpost('/cloud/reset', {});
      profileKey = null; profileSalt = ''; profileIterations = 210000; profileUnlocked = false; fileSecretKey = null; cloudRevision = 0;
      try { sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch(e) {}
      busy = false; refresh();
      var pwd = await askPassword('set');
      if (!pwd) { status(L('云端已重置，请重新设置密码','Cloud reset. Set a new password.')); return; }
      profileIterations = 210000;
      profileSalt = toB64(crypto.getRandomValues(new Uint8Array(16)));
      profileKey = await deriveProfileKey(pwd, profileSalt, profileIterations);
      await rememberProfileKey();
      await deriveFileSecret();
      // Cloud walls were deleted; keep local wallpapers by marking them dirty
      // so the following sync uploads them instead of pulling empty cloud.
      for (var m of ['desktop','mobile']) {
        try {
          var lw = typeof wallGet === 'function' ? await wallGet(m) : null;
          if (lw && String(lw).indexOf('data:image') === 0) setWallDirty(m, true, undefined, lw);
        } catch(e) {}
      }
      status(L('已重置，正在上传本机数据…','Reset. Uploading local data…'));
      await syncNow();
    } catch(e) { status(L('重置失败：','Reset failed: ') + (e && e.message ? e.message : e), true); }
    busy = false; refresh();
  }
  function localData(){
    try {
      return {
        apps: (typeof apps !== 'undefined' ? apps : []).filter(function(a){ return a && !a.seed; }),
        installed: (typeof installed !== 'undefined' ? installed : {}) || {},
        aliases: (typeof aliases !== 'undefined' ? aliases : {}) || {},
        hidden: (typeof hidden !== 'undefined' ? hidden : {}) || {},
        deskPos: (typeof deskPos !== 'undefined' ? deskPos : {}) || {},
        removed: (typeof removed !== 'undefined' ? removed : {}) || {},
        folders: (typeof folders !== 'undefined' ? folders : []) || [],
        order: (typeof apps !== 'undefined' && Array.isArray(apps)) ? apps.map(function(a){ return a && a.name; }).filter(Boolean) : [],
        fileMasterKey: fileMasterKeyB64 || ''
      };
    } catch(e) { return {apps:[],installed:{},aliases:{},hidden:{},deskPos:{},removed:{},folders:[]}; }
  }
  function cleanUrl(v){
    try {
      var u = new URL(String(v || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      if (u.username || u.password) return '';
      return u.href;
    } catch(e) { return ''; }
  }
  function safeKeys(o){
    var out = Object.create(null);
    Object.keys(o || {}).forEach(function(k){
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      var v = o[k];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[cleanString(k, 200)] = v;
    });
    return out;
  }
  function mergeData(local, remote){
    remote = remote || {};
    var by = Object.create(null);
    (remote.apps || []).forEach(function(a){ if (a && a.name) by[a.name] = a; });
    (local.apps || []).forEach(function(a){ if (a && a.name) by[a.name] = a; });
    var out = Object.create(null);
    out.apps = Object.keys(by).map(function(k){ return by[k]; });
    out.installed = safeKeys(Object.assign(Object.create(null), remote.installed || {}, local.installed || {}));
    out.aliases = safeKeys(Object.assign(Object.create(null), remote.aliases || {}, local.aliases || {}));
    out.hidden = safeKeys(Object.assign(Object.create(null), remote.hidden || {}, local.hidden || {}));
    out.deskPos = cleanDeskPos(Object.assign(Object.create(null), remote.deskPos || {}, local.deskPos || {}));
    out.removed = safeKeys(Object.assign(Object.create(null), remote.removed || {}, local.removed || {}));
    var fs = Object.create(null);
    (remote.folders || []).forEach(function(f){ if (f && f.id) fs[f.id] = f; });
    (local.folders || []).forEach(function(f){ if (f && f.id) fs[f.id] = f; });
    out.folders = Object.keys(fs).map(function(k){ return fs[k]; });
    var ordSeen = Object.create(null), ord = [];
    [].concat(local.order || [], remote.order || [], (local.apps || []).map(function(a){ return a && a.name; }), (remote.apps || []).map(function(a){ return a && a.name; })).forEach(function(n){
      if (typeof n === 'string' && !ordSeen[n]) { ordSeen[n] = 1; ord.push(n); }
    });
    out.order = ord;
    out.fileMasterKey = remote.fileMasterKey || local.fileMasterKey || '';
    return out;
  }
  function dedupeApps(list){
    var seen = {}, out = [];
    (list || []).forEach(function(a){ if (!a || !a.name || seen[a.name]) return; seen[a.name] = 1; out.push(a); });
    return out;
  }
  function cleanString(v, max) {
    return String(v == null ? '' : v).slice(0, max || 200);
  }
  function cleanApps(list) {
    return (Array.isArray(list) ? list : []).filter(function(a){ return a && typeof a === 'object'; }).map(function(a){
      var o = Object.create(null);
      o.name = cleanString(a.name, 160);
      if (!o.name) return null;
      ['zh','en','cpuName','part','title'].forEach(function(k){
        if (a[k] != null) o[k] = cleanString(a[k], 200);
      });
      if (a.url != null) o.url = cleanUrl(a.url);
      if (a.chain != null) o.chain = cleanString(a.chain, 32);
      if (a.sub != null) {
        var sub = cleanString(a.sub, 63);
        if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(sub)) o.sub = sub;
      }
      if (a.tokenId != null && Number.isFinite(Number(a.tokenId))) o.tokenId = Number(a.tokenId);
      if (a.cpuIdx != null && Number.isFinite(Number(a.cpuIdx))) o.cpuIdx = Number(a.cpuIdx);
      if (a.area != null && Number.isFinite(Number(a.area))) o.area = Number(a.area);
      o.files = Math.max(0, Math.floor(Number(a.files) || 0));
      if (a.manual) o.manual = 1;
      return o;
    }).filter(Boolean);
  }
  function cleanDeskPos(v) {
    var out = Object.create(null);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    Object.keys(v).forEach(function(k){
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      var p = v[k];
      if (!p || typeof p !== 'object' || Array.isArray(p)) return;
      var x = Number(p.x), y = Number(p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      out[cleanString(k, 200)] = { x: Math.max(-100000, Math.min(100000, x)), y: Math.max(-100000, Math.min(100000, y)) };
    });
    return out;
  }
  function cleanMap(v) {
    var out = Object.create(null);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
    Object.keys(v).forEach(function(k){
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      var x = v[k];
      if (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') out[cleanString(k, 200)] = x;
    });
    return out;
  }
  function cleanFolders(list) {
    return (Array.isArray(list) ? list : []).filter(function(f){ return f && typeof f === 'object' && f.id; }).map(function(f){
      var o = Object.create(null);
      o.id = cleanString(f.id, 120);
      o.name = cleanString(f.name, 120);
      o.apps = Array.isArray(f.apps) ? f.apps.map(function(n){ return cleanString(n, 160); }) : [];
      return o;
    });
  }
  function applyData(data){
    if (!data) return;
    applyingCloud = true;
    try {
      var seeds = (typeof apps !== 'undefined' ? apps : []).filter(function(a){ return a && a.seed; });
      if (typeof apps !== 'undefined') {
        var nextApps = dedupeApps(seeds.concat(cleanApps(data.apps)));
        if (Array.isArray(data.order) && data.order.length) {
          var iord = Object.create(null);
          data.order.forEach(function(n, i){ if (typeof n === 'string') iord[n] = i; });
          nextApps.sort(function(a,b){ var ia = iord[a.name]; var ib = iord[b.name]; if (ia == null) ia = 1e9; if (ib == null) ib = 1e9; return ia - ib; });
        }
        apps = nextApps;
      }
      if (typeof installed !== 'undefined') installed = cleanMap(data.installed);
      if (typeof aliases !== 'undefined') aliases = cleanMap(data.aliases);
      if (typeof hidden !== 'undefined') hidden = cleanMap(data.hidden);
      if (typeof deskPos !== 'undefined') deskPos = cleanDeskPos(data.deskPos);
      if (typeof removed !== 'undefined') removed = cleanMap(data.removed);
      if (typeof folders !== 'undefined') folders = cleanFolders(data.folders);
      if (data.fileMasterKey) {
        try { var fm = fromB64(String(data.fileMasterKey)); if (fm.length === 32) { fileMasterSecret = fm; fileMasterKeyB64 = String(data.fileMasterKey); } } catch(e) {}
      }
      if (typeof saveProfile === 'function') saveProfile();
      if (typeof saveFolders === 'function') saveFolders();
      if (typeof render === 'function') render();
    } finally { applyingCloud = false; }
  }
  async function pushProfile(data, revision, attempt){
    if (!profileKey) throw new Error('请先设置云同步密码');
    var epoch = profileEpoch;
    var owner = cloudAddress;
    function stillCurrent(){ return epoch === profileEpoch && owner === cloudAddress; }
    ensureMasterKey();
    if (data && !data.fileMasterKey) data.fileMasterKey = fileMasterKeyB64;
    var encrypted = await encryptProfile(data);
    if (!stillCurrent()) throw new Error('云账号已切换，已取消旧同步');
    // 模板 A：profile 直传 TapeRelay，Worker 只签名和写指针。
    // 直传失败时才回退到旧的 Worker 代理路径。
    if (window.DeWEBTapeDirect && token) {
      try {
        var fsk2 = await deriveFileSecret();
        var direct = await window.DeWEBTapeDirect.uploadProfile(encrypted, revision, token, fsk2, owner);
        if (!stillCurrent()) throw new Error('云账号已切换，已取消旧同步');
        cloudRevision = Number(direct && direct.revision || cloudRevision + 1);
        return direct;
      } catch (de) {
        if (isTape401(de)) { expireCloudSession(); throw new Error('云同步登录已过期，请重新登录'); }
        if (!stillCurrent()) throw new Error('云账号已切换，已取消旧同步');
        var code = de && de.payload && de.payload.code || '';
        if (code === 'FINISH_BUSY' || code === 'REGISTER_BUSY') {
          if ((attempt || 0) < 4) {
            status(L('云端同步排队中，稍后自动重试','Cloud sync busy; retrying'), false);
            await new Promise(function(r){ setTimeout(r, 1500 * ((attempt || 0) + 1)); });
            return pushProfile(data, revision, (attempt || 0) + 1);
          }
          throw new Error('云同步繁忙，请稍后重试');
        }
        if (de && de.status === 409 && code === 'REVISION_CONFLICT') {
          if ((attempt || 0) >= 3) throw new Error('云端版本冲突，请稍后重试');
          cloudRevision = Number(de.payload && de.payload.revision || 0);
          var r2 = await jget('/profile');
          r2 = await hydrateRemote(r2);
          var rp2 = await decodeRemoteProfile(r2 && r2.data);
          var mm2 = mergeData(localData(), rp2);
          applyData(mm2);
          return pushProfile(mm2, cloudRevision, (attempt || 0) + 1);
        }
        if (de && de.status === 409) throw new Error((de.payload && (de.payload.message || de.payload.error)) || '云端状态冲突');
        // 继续走旧路径，保证功能不被前端直传故障卡死
      }
    }
    throw new Error('TapeRelay 直传失败，Worker 文件代理已禁用');
  }
  function schedulePush(){
    if (!token || !cloudAddress || applyingCloud || !sameAccount() || busy || !profileKey) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function(){
      pushTimer = null;
      if (!token || applyingCloud || !sameAccount()) return;
      var p = pushProfile(localData(), cloudRevision);
      activePush = p;
      p.catch(function(e){ status(L('后台同步失败：','Background sync failed: ') + (e && e.message ? e.message : e), true); })
        .then(function(){ if (activePush === p) activePush = null; });
    }, 1200);
  }
  function dataUrlBlob(data){
    var m = String(data || '').match(/^data:([^;,]+)(;base64)?,(.*)$/);
    if (!m) throw new Error('壁纸数据格式无效');
    var bin = atob(m[3] || '');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], {type:m[1]});
  }
  async function uploadWall(mode, data, attempt, seq){
    if (!data || String(data).indexOf('data:image') !== 0) {
      // Wallpaper removed/invalid: allow cloud pull to restore the last one.
      setWallDirty(mode, false);
      return;
    }
    if (seq != null && seq !== wallSeq[mode]) return;
    // Remember that the local wallpaper is newer than the cloud copy. Bind it
    // to this wallet so account B never uploads account A's local image.
    var wallOwner = wallDirtyOwner();
    setWallDirty(mode, true, wallOwner, data);
    if (!sameAccount()) { pendingWalls[mode] = data; return; }
    if (!token || !sameAccount()) {
      pendingWalls[mode] = data;
      status(L('壁纸已本地保存；登录云同步后会自动上传','Wallpaper saved locally; it will upload after cloud sign-in'), false);
      return;
    }
    if (!profileKey) {
      pendingWalls[mode] = data;
      status(L('壁纸已本地保存；解锁云同步后会自动上传','Wallpaper saved locally; it will upload after cloud unlock'), false);
      return;
    }
    try {
      var blob = dataUrlBlob(data);
      if (!/^image\/(jpeg|png|webp)$/i.test(blob.type) || blob.size > 25 * 1024 * 1024) {
        // Invalid/too-large local wallpaper cannot be synced; let cloud pull
        // restore a valid one.
        if (seq == null || seq === wallSeq[mode]) setWallDirty(mode, false, wallOwner);
        return;
      }
      var enc = await encryptWall(blob, mode);
      if (window.DeWEBTapeDirect && token) {
        try {
          var fsk3 = await deriveFileSecret();
          var master = ensureMasterKey();
          var d = await window.DeWEBTapeDirect.uploadWallpaper(enc.ct, mode, {mime:blob.type, iv:enc.iv, aad:'v2'}, token, master);
          if (d && d.quota) setQuota(d.quota);
          if (seq == null || seq === wallSeq[mode]) {
            delete pendingWalls[mode];
            setWallDirty(mode, false, wallOwner);
          }
          return;
        } catch(e) {
          if (isTape401(e)) { expireCloudSession(); throw new Error('云同步登录已过期，请重新登录'); }
          var busy = e && (e.status === 409 || (e.payload && (e.payload.code === 'FINISH_BUSY' || e.payload.code === 'REGISTER_BUSY' || e.payload.error === '同步进行中，请稍后重试')));
          if (busy && (attempt || 0) < 4) {
            if (seq == null || seq === wallSeq[mode]) pendingWalls[mode] = data;
            status(L('云端同步排队中，稍后自动重试','Cloud sync busy; retrying'), false);
            setTimeout(function(){ if ((seq == null || seq === wallSeq[mode]) && pendingWalls[mode] === data) uploadWall(mode, data, (attempt || 0) + 1, seq); }, 1500 * ((attempt || 0) + 1));
            return;
          }
          if (seq == null || seq === wallSeq[mode]) pendingWalls[mode] = data;
          throw new Error('TapeRelay 壁纸直传失败：' + (e && e.message ? e.message : e));
        }
      }
      if (seq == null || seq === wallSeq[mode]) pendingWalls[mode] = data;
      throw new Error('TapeRelay 壁纸直传不可用');
    } catch(e) {
      status(e && e.message ? e.message : String(e), true);
    }
  }
  async function flushPendingWalls(){
    for (var mode of ['desktop','mobile']) {
      if (!pendingWalls[mode]) continue;
      var data = pendingWalls[mode];
      delete pendingWalls[mode];
      await uploadWall(mode, data, 0, wallSeq[mode]);
    }
  }
  async function pushDirtyLocalWall(mode){
    if (!wallDirty(mode)) return;
    if (typeof wallGet !== 'function' || !token || !sameAccount() || !profileKey) return;
    try {
      var local = await wallGet(mode);
      if (!local || String(local).indexOf('data:image') !== 0) {
        setWallDirty(mode, false);
        return;
      }
      // The device-wide IDB may now hold another account's image; do not
      // upload it to this account's cloud.
      if (!wallDirtyMatches(mode, local)) {
        setWallDirty(mode, false);
        return;
      }
      await uploadWall(mode, local, 0, ++wallSeq[mode]);
    } catch(e) {}
  }
  async function pullWalls(){
    for (var i = 0; i < 2; i++) {
      var mode = i === 0 ? 'desktop' : 'mobile';
      // Local change not yet uploaded wins; otherwise an old cloud wallpaper
      // would overwrite the one the user just set.
      if (wallDirty(mode)) continue;
      try {
        if (window.DeWEBTapeDirect && token) {
          try {
            var fsk4 = await deriveFileSecret();
            var master4 = ensureMasterKey();
            var w = await window.DeWEBTapeDirect.readWallpaper(mode, token, [master4, fsk4]);
            if (w && w.bytes && w.meta && w.meta.iv) {
              var blob2 = await decryptWallBytes(w.bytes, w.meta.iv, w.meta.mime || 'image/jpeg', mode, w.meta.aad || '');
              var data2 = await new Promise(function(resolve){ var fr = new FileReader(); fr.onload = function(){ resolve(fr.result); }; fr.readAsDataURL(blob2); });
              if (data2 && typeof applyWallpaperTo === 'function') {
                applyingCloud = true;
                try { applyWallpaperTo(mode, data2, true); } finally { applyingCloud = false; }
              }
              continue;
            }
          } catch(e) { if (isTape401(e)) { expireCloudSession(); return; } }
        }
        throw new Error('TapeRelay 壁纸直读失败，Worker 文件代理已禁用');
      } catch(e) {}
    }
  }
  function expireCloudSession(){
    profileEpoch++;
    token = ''; cloudAddress = ''; cloudRevision = 0; lastMembership = null;
    window.__dewebCloudAddress = '';
    profileKey = null; profileSalt = ''; profileIterations = 210000; profileUnlocked = false;
    fileSecretKey = null; fileMasterSecret = null; fileMasterKeyB64 = ''; pendingWalls = {};
    try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch(e) {}
    try { setTimeout(refresh, 0); } catch(e) {}
  }
  function isTape401(e){ return !!(e && (e.status === 401 || /401|未登录|登录已过期/.test(String(e.message || '')))); }
  function friendlySyncError(e){
    var m = e && e.message ? String(e.message) : String(e || '');
    var n = e && e.name ? String(e.name) : '';
    if (n === 'OperationError' || /operation failed|decrypt|auth/i.test(m)) {
      return L('云同步密码错误或云端数据损坏', 'Cloud password incorrect or cloud data damaged');
    }
    return m || 'unknown error';
  }
  async function syncNow(){
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    try {
      do {
        syncQueued = false;
        await syncNowInner();
      } while (syncQueued);
    } finally { syncing = false; }
  }
  async function syncNowInner(){
    if (!token){ status(L('请先登录云同步','Sign in first'), true); return; }
    if (!liveAccount()){ status(L('请先连接钱包','Connect a wallet first'), true); return; }
    if (!sameAccount()){ status(L('钱包与云端账号不一致，请重新登录','Wallet does not match cloud account'), true); return; }
    status(L('正在同步…','Syncing…'));
    try {
      await restoreProfileKey();
      var remote = await jget('/profile');
      if (!await unlockRemoteProfile(remote)) { status(L('已取消同步','Sync cancelled')); return; }
      try {
        remote = await hydrateRemote(remote);
      } catch(hy) {
        // 禁止自动用本机数据覆盖云端；读取失败时停止并提示重试。
        profileUnlocked = false;
        status(L('云端文件读取失败，已停止同步。请重试；如持续失败可重置云同步。','Cloud file unreadable; sync stopped. Retry, or reset cloud if it persists.'), true);
        refresh();
        return;
      }
      if (remote && remote.quota) setQuota(remote.quota);
      var rev = Number(remote && remote.revision || 0);
      var remoteData = remote && remote.data;
      if (remoteData && (remoteData.enc === 1 || remoteData.enc === 2)) {
        if (!await ensureProfileKey(remoteData)) { status(L('已取消同步','Sync cancelled')); return; }
      } else {
        if (!await ensureProfileKey(null)) { status(L('已取消同步','Sync cancelled')); return; }
      }
      var remotePlain = null;
      try {
        remotePlain = await decodeRemoteProfile(remoteData);
      } catch(e) {
        profileKey = null; profileSalt = ''; profileIterations = 210000;
        try { sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch(_) {}
        profileUnlocked = false;
        status(L('云同步密码错误或数据已更改，请重试','Cloud password incorrect or data changed; retry'), true);
        refresh();
        return;
      }
      // 合并前先保存本地快照；绝不能先用远端 applyData，否则本地新增的 3 个会被覆盖。
      var localSnapshot = localData();
      if (remotePlain && remotePlain.fileMasterKey) {
        try {
          var fm2 = fromB64(String(remotePlain.fileMasterKey));
          if (fm2.length === 32) { fileMasterSecret = fm2; fileMasterKeyB64 = String(remotePlain.fileMasterKey); }
        } catch(e) {}
      }
      ensureMasterKey();
      var merged = remotePlain ? mergeData(localSnapshot, remotePlain) : localSnapshot;
      if (!merged.fileMasterKey) merged.fileMasterKey = fileMasterKeyB64;
      applyData(merged);
      cloudRevision = rev;
      var pushPromise = pushProfile(merged, rev);
      activePush = pushPromise;
      try { await pushPromise; } finally { if (activePush === pushPromise) activePush = null; }
      await pushDirtyLocalWall('desktop');
      await pushDirtyLocalWall('mobile');
      await flushPendingWalls();
      await pullWalls();
      if (!token) {
        status(L('云同步登录已过期，请重新登录','Cloud session expired; sign in again'), true);
        return;
      }
      profileUnlocked = true;
      status(L('云端同步完成','Cloud sync complete'));
      window.dispatchEvent(new CustomEvent('deweb-cloud-profile', {detail:merged}));
      refresh();
    } catch(e) {
      profileUnlocked = false;
      status(L('同步失败：','Sync failed: ') + friendlySyncError(e), true);
      refresh();
    }
  }
  function hookWrites(){
    if (window.__dewebCloudHooked) return;
    window.__dewebCloudHooked = true;
    var sp = window.saveProfile;
    if (typeof sp === 'function') window.saveProfile = function(){ var r = sp.apply(this, arguments); schedulePush(); return r; };
    var sf = window.saveFolders;
    if (typeof sf === 'function') window.saveFolders = function(){ var r = sf.apply(this, arguments); schedulePush(); return r; };
    var wp = window.wallPut;
    if (typeof wp === 'function') window.wallPut = function(mode, data){ var p = wp.apply(this, arguments); if (!applyingCloud) { try { var seq=++wallSeq[mode]; p.then(function(){ uploadWall(mode, data, 0, seq); if (token && sameAccount() && !profileKey && !busy) syncNow(); }); } catch(e) {} } return p; };
  }
  function buildPro(){
    if (document.getElementById('proMask')) return;
    var style = document.createElement('style');
    style.textContent = '#proMask .modal{max-width:430px}#proMask .bd{display:flex;flex-direction:column;gap:10px}#proMask .pr-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--trace);padding:7px 0;font:11px/1.6 var(--mono);color:var(--dim)}#proMask .pr-row b{color:var(--silk);font-weight:500;text-align:right;word-break:break-all}#proMask .pr-note{font-size:10px;line-height:1.8;color:var(--dim);border:1px solid var(--trace);background:var(--board);padding:9px;border-radius:10px}#proMask .pr-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}#proMask .pr-btn{border:1px solid rgba(224,255,242,.20);border-radius:999px;background:rgba(255,255,255,.08);color:var(--silk);padding:7px 11px;font:11px var(--sans);cursor:pointer}';
    document.head.appendChild(style);
    var mask = el('div','mask'); mask.id='proMask';
    var modal = el('div','modal');
    var hd = el('div','hd'); hd.appendChild(el('span',null,L('Pro 会员','PRO MEMBERSHIP')));
    var close = el('span',null,'✕'); close.style.cursor='pointer'; close.id='proClose'; hd.appendChild(close); modal.appendChild(hd);
    var bd = el('div','bd');
    function row(label,id){ var r=el('div','pr-row'); r.appendChild(el('span',null,label)); var b=el('b',null,'—'); b.id=id; r.appendChild(b); bd.appendChild(r); return b; }
    row(L('钱包地址','WALLET'),'proAddr');
    row(L('会员到期','MEMBERSHIP'),'proExpiry');
    row(L('云空间','STORAGE'),'proQuota');
    var note=el('div','pr-note'); note.textContent=L('Alpha 测试期 Pro 自动免费至 2026-12-31；到期后以正式公告为准。','Alpha Pro is automatically free until 2026-12-31; details will be announced later.'); bd.appendChild(note);
    var st=el('div','pr-note'); st.id='proStatus'; st.style.minHeight='16px'; bd.appendChild(st);
    var actions=el('div','pr-actions');
    var connect=el('button','pr-btn',L('连接钱包','CONNECT WALLET')); connect.id='proConnect'; actions.appendChild(connect);
    var again=el('button','pr-btn',L('刷新会员状态','REFRESH')); again.id='proRefresh'; actions.appendChild(again);
    bd.appendChild(actions); modal.appendChild(bd);
    var ft=el('div','ft'); var done=el('button','btn',L('关闭','CLOSE')); done.id='proDone'; ft.appendChild(done); modal.appendChild(ft);
    mask.appendChild(modal); document.body.appendChild(mask);
    close.onclick=done.onclick=function(){ mask.classList.remove('on'); };
    mask.addEventListener('click', function(e){ if(e.target===mask) mask.classList.remove('on'); });
    connect.onclick=function(){
      if(account()){ refresh(); return; }
      if(typeof connectWallet==='function'){ connectWallet(); setTimeout(refresh, 1200); }
      else if(nativeAvailable()){ nativeCall('connect','').then(function(){ refresh(); }).catch(function(e){ status(e.message,true); }); }
    };
    again.onclick=function(){ refresh(); };
  }
  function refreshPro(){
    buildPro();
    var a=account();
    var addr=document.getElementById('proAddr'), exp=document.getElementById('proExpiry'), q=document.getElementById('proQuota');
    if(!addr) return;
    addr.textContent = a ? (a.slice(0,10)+'…'+a.slice(-6)) : L('未连接','Not connected');
    if(exp) exp.textContent = a ? (lastMembership === null ? L('查询中…','Checking…') : (!lastMembership || !lastMembership.active ? L('未开通','Not active') : (lastMembership.source === 'circuit' ? L('电路会员','Circuit Pro') : (lastMembership.alpha ? L('Alpha 测试期免费 Pro · 至 2026-12-31','Alpha free Pro · until 2026-12-31') : L('Pro 已激活','Pro active'))))) : '—';
    if(q) q.textContent = lastQuota ? (fmtSize(lastQuota.used||0)+' / '+fmtSize(lastQuota.limit||0)) : '—';
  }
  function openPro(){
    try {
      if (window.dewebBridge && typeof window.dewebBridge.postMessage === 'function') {
        window.dewebBridge.postMessage(JSON.stringify({ id: 'pro-' + Date.now(), method: 'deweb_open_pro', bridgeVersion: 1 }));
        return;
      }
    } catch(e) {}
    try {
      if (window.dewebCloudPro && typeof window.dewebCloudPro.open === 'function') {
        window.dewebCloudPro.open();
        return;
      }
    } catch(e) {}
    buildPro();
    var mask=document.getElementById('proMask');
    if(mask) mask.classList.add('on');
    refreshPro();
    refresh();
  }
  function addButtons(){
    var tray = document.querySelector('.dtray');
    if (tray && !document.getElementById('deskCloud')){
      var b = document.createElement('button'); b.className='dtrayb'; b.id='deskCloud'; b.title=L('会员云同步','Member cloud'); b.textContent=L('云同步','CLOUD');
      b.onclick = function(){ document.getElementById('cmMask').classList.add('on'); refresh(); };
      var before = document.getElementById('deskMountBtn'); tray.insertBefore(b, before || null);
      var p = document.createElement('button'); p.className='dtrayb'; p.id='deskPro'; p.title=L('Pro 状态','Pro status'); p.textContent='Pro';
      p.onclick = openPro;
      tray.insertBefore(p, b.nextSibling);
    }
    var mr = document.querySelector('.mstatus-r');
    if (mr && !document.getElementById('mCloud')){
      var mb = document.createElement('button'); mb.className='mtheme'; mb.id='mCloud'; mb.title=L('会员云同步','Member cloud'); mb.textContent='☁';
      mb.onclick = function(){ document.getElementById('cmMask').classList.add('on'); refresh(); };
      mr.insertBefore(mb, mr.firstChild);
      var mp = document.createElement('button'); mp.className='mtheme'; mp.id='mPro'; mp.title=L('Pro 状态','Pro status'); mp.textContent='Pro';
      mp.onclick = openPro;
      mr.insertBefore(mp, mb.nextSibling);
    }
  }
  function onWalletChanged(){
    try {
      var p = provider();
      if (p && p.on) p.on('accountsChanged', function(){ setTimeout(refresh, 200); });
    } catch(e) {}
  }
  function addWebBrand(){
    try {
      if (window.dewebBridge || window.dewebCloudAuth) return;
      if (document.getElementById('dewebWebBrand')) return;
      var el = document.createElement('div');
      el.id = 'dewebWebBrand';
      el.style.cssText = 'position:fixed;left:14px;top:14px;z-index:2147483000;display:flex;align-items:center;gap:9px;padding:7px 12px 7px 7px;border-radius:16px;background:linear-gradient(135deg,rgba(255,255,255,.82),rgba(255,255,255,.52));border:1px solid rgba(255,255,255,.95);box-shadow:0 10px 30px rgba(40,30,20,.10),inset 0 1px 0 #fff;backdrop-filter:blur(22px) saturate(140%);pointer-events:none;font-family:Inter,system-ui,sans-serif;';
      var img = document.createElement('img');
      img.src = 'data:image/png;base64,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';
      img.style.cssText = 'width:30px;height:30px;border-radius:9px;display:block;box-shadow:0 5px 14px rgba(40,30,20,.12);';
      var txt = document.createElement('div');
      txt.innerHTML = '<div style="font:800 12px/1.1 Inter,system-ui,sans-serif;color:#0b0d0d;letter-spacing:-.2px">DeWEB <span style="font-weight:300;color:#ff5a2d">DESK</span></div><div style="font:7px/1.4 ui-monospace,monospace;letter-spacing:.18em;color:#7b7468;margin-top:3px">ON-CHAIN DESKTOP</div>';
      el.appendChild(img); el.appendChild(txt); document.body.appendChild(el);
    } catch(e) {}
  }
  function init(){
    build(); addButtons(); onWalletChanged(); hookWrites(); addWebBrand();
    restoreProfileKey();
    restoreSession();
    window.addEventListener('deweb-cloud-disconnected', function(){
      token = ''; cloudAddress = ''; cloudRevision = 0; lastMembership = null;
      window.__dewebCloudAddress = '';
      profileKey = null; profileSalt = ''; profileIterations = 210000; profileUnlocked = false;
      fileSecretKey = null; fileMasterSecret = null; fileMasterKeyB64 = ''; pendingWalls = {};
      try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(PROFILE_SESSION_KEY); sessionStorage.removeItem(PROFILE_SESSION_SALT); } catch(e) {}
      var q = document.getElementById('cmQuota');
      if (q) q.textContent = '—';
      refresh();
    });
    var mask = document.getElementById('cmMask');
    if (mask) mask.classList.remove('on');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.DeWEBCloudMembership = {refresh:refresh, api:API, logout:signOutCloud};
})();
