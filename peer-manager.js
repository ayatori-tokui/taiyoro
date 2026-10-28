/**
 * peer-manager.js
 * ------------------------------------------------------------
 * PeerJS による 1対1 P2P 接続の管理モジュール。
 *
 *  - ホスト(ルーム作成) / ゲスト(参加) の接続確立
 *  - 状態同期メッセージの送受信 (send / onData)
 *  - 切断検知 (close / error / ハートビート途絶)
 *  - 自動再接続
 *      ゲスト : ホストIDへ一定間隔で再接続を試行
 *      ホスト : peer.reconnect() によるシグナリング再接続 + ゲスト待ち受け
 *  - localStorage によるセッション (対局状態) 永続化
 *
 * 公開API: window.PeerManager
 * ------------------------------------------------------------
 */
const PeerManager = (() => {
  'use strict';

  // ---------- 定数 ----------
  const STORAGE_KEY = 'cardGameChessClock.session.v1';
  const HOST_ID_PREFIX = 'cgclock-';
  const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  const PEER_OPTIONS = {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
    },
  };
  const GUEST_RETRY_MS = 3000;       // ゲストの再接続試行間隔
  const HOST_SIGNAL_RETRY_MS = 3000; // ホストのシグナリング再接続間隔
  const CONNECT_TIMEOUT_MS = 8000;   // 1回の接続試行のタイムアウト
  const HEARTBEAT_MS = 4000;         // ping送信間隔 (タイマー値は含まない)
  const DEAD_MS = 12000;             // この時間受信が無ければ切断扱い
  const HOST_ID_RETRY_LIMIT = 10;    // 復元時のID再取得リトライ上限

  const noop = () => {};

  // ---------- 状態 ----------
  let handlers = {
    onRoomReady: noop,   // (hostId) ホストのPeerID確定
    onConnected: noop,   // ({reconnect:boolean}) データ接続確立
    onDisconnected: noop,// (reason) データ接続断
    onData: noop,        // (message) アプリ用メッセージ受信
    onStatus: noop,      // (text) 状況テキスト
    onRetry: noop,       // (attempt) ゲスト再接続試行回数
    onError: noop,       // (text) 致命的エラー
  };

  let peer = null;
  let conn = null;        // 確立済みデータ接続
  let pending = null;     // 接続試行中 (ゲスト)
  let pendingSince = 0;
  let role = null;        // 'host' | 'guest' | null
  let hostId = null;
  let preferredHostId = null;
  let everConnected = false;

  let guestTimer = null;
  let hostSignalTimer = null;
  let hostOpenTimer = null;
  let heartbeatTimer = null;
  let lastRx = 0;
  let lastBeat = 0;
  let latency = 0;        // 片道遅延の推定値(ms)
  let attempts = 0;
  let idRetry = 0;

  // ---------- ユーティリティ ----------
  function randomId() {
    let s = '';
    for (let i = 0; i < 6; i++) {
      s += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    }
    return HOST_ID_PREFIX + s;
  }

  function init(h) {
    handlers = Object.assign({}, handlers, h || {});
  }

  function getJoinUrl(id) {
    const base = location.origin + location.pathname;
    return base + '?join=' + encodeURIComponent(id || hostId || '');
  }

  function stopGuestTimer() {
    if (guestTimer) { clearInterval(guestTimer); guestTimer = null; }
  }
  function stopHostSignalTimer() {
    if (hostSignalTimer) { clearInterval(hostSignalTimer); hostSignalTimer = null; }
  }
  function stopHostOpenTimer() {
    if (hostOpenTimer) { clearTimeout(hostOpenTimer); hostOpenTimer = null; }
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function destroyPeerOnly() {
    const p = peer;
    peer = null; // 先に null にして旧Peerのイベントを無視させる
    if (p) {
      try { p.destroy(); } catch (e) { /* noop */ }
    }
  }

  function cleanupAll() {
    stopGuestTimer();
    stopHostSignalTimer();
    stopHostOpenTimer();
    stopHeartbeat();
    const c = conn;
    const pd = pending;
    conn = null;
    pending = null;
    if (c) { try { c.close(); } catch (e) { /* noop */ } }
    if (pd) { try { pd.close(); } catch (e) { /* noop */ } }
    destroyPeerOnly();
  }

  // ---------- 公開: ルーム作成 / 参加 / 終了 ----------
  /** ホストとしてルームを作成。復元時は preferredId を指定して同じIDを再取得する。 */
  function createRoom(preferredId) {
    cleanupAll();
    role = 'host';
    preferredHostId = preferredId || null;
    hostId = preferredId || randomId();
    everConnected = false;
    idRetry = 0;
    handlers.onStatus('シグナリングサーバーへ接続中…');
    openHostPeer();
  }

  /** ゲストとして指定ホストへ参加。失敗しても自動で再試行し続ける。 */
  function joinRoom(targetHostId) {
    cleanupAll();
    role = 'guest';
    hostId = targetHostId;
    everConnected = false;
    attempts = 0;
    handlers.onStatus('ホストへ接続中…');
    openGuestPeer();
    startGuestRetry();
  }

  /** 接続を完全に終了する (設定画面へ戻る等)。 */
  function close() {
    cleanupAll();
    role = null;
    hostId = null;
    preferredHostId = null;
    everConnected = false;
  }

  // ---------- ホスト側 ----------
  function openHostPeer() {
    if (role !== 'host') return;
    destroyPeerOnly();
    const p = new Peer(hostId, PEER_OPTIONS);
    peer = p;

    p.on('open', (openedId) => {
      if (p !== peer) return;
      hostId = openedId;
      idRetry = 0;
      stopHostSignalTimer();
      handlers.onStatus('ゲストの接続を待っています…');
      handlers.onRoomReady(openedId);
    });

    p.on('connection', (c) => {
      if (p !== peer) { try { c.close(); } catch (e) { /* noop */ } return; }
      setupConn(c);
    });

    p.on('disconnected', () => {
      if (p !== peer) return;
      handlers.onStatus('シグナリング切断。再接続中…');
      scheduleHostSignalReconnect();
    });

    p.on('close', () => {
      if (p !== peer) return;
      peer = null;
      scheduleHostSignalReconnect();
    });

    p.on('error', (err) => {
      if (p !== peer) return;
      onHostPeerError(err);
    });
  }

  function scheduleHostSignalReconnect() {
    if (role !== 'host' || hostSignalTimer) return;
    const tryReconnect = () => {
      if (role !== 'host') { stopHostSignalTimer(); return; }
      if (!peer || peer.destroyed) {
        if (!hostOpenTimer) openHostPeer();
        return;
      }
      if (peer.disconnected) {
        try { peer.reconnect(); } catch (e) { /* 次回リトライ */ }
      } else {
        stopHostSignalTimer();
      }
    };
    hostSignalTimer = setInterval(tryReconnect, HOST_SIGNAL_RETRY_MS);
    tryReconnect();
  }

  function onHostPeerError(err) {
    const t = err && err.type;
    if (t === 'unavailable-id') {
      idRetry += 1;
      destroyPeerOnly();
      if (preferredHostId) {
        // 復元時: ブローカー側で前回セッションが残っている間は同じIDを粘り強く再取得
        if (idRetry <= HOST_ID_RETRY_LIMIT) {
          handlers.onStatus('ルームIDを再取得中… (' + idRetry + '/' + HOST_ID_RETRY_LIMIT + ')');
          stopHostOpenTimer();
          hostOpenTimer = setTimeout(() => {
            hostOpenTimer = null;
            if (role === 'host' && !peer) openHostPeer();
          }, 2500);
        } else {
          handlers.onError('前回のルームIDを再取得できませんでした。しばらく待つか、新しくルームを作成してください。');
        }
      } else {
        hostId = randomId(); // 新規作成時のID衝突は別IDで再作成
        openHostPeer();
      }
      return;
    }
    if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].indexOf(t) >= 0) {
      scheduleHostSignalReconnect();
      return;
    }
    if (t === 'peer-unavailable') return;
    handlers.onError('通信エラー: ' + (t || 'unknown'));
  }

  // ---------- ゲスト側 ----------
  function openGuestPeer() {
    if (role !== 'guest') return;
    destroyPeerOnly();
    const p = new Peer(PEER_OPTIONS);
    peer = p;

    p.on('open', () => {
      if (p !== peer) return;
      attemptGuestConnect();
    });

    p.on('disconnected', () => {
      if (p !== peer) return;
      try { p.reconnect(); } catch (e) { /* 次回リトライ */ }
    });

    p.on('close', () => {
      if (p !== peer) return;
      peer = null;
    });

    p.on('error', (err) => {
      if (p !== peer) return;
      const t = err && err.type;
      if (t === 'peer-unavailable') {
        pending = null;
        handlers.onStatus('ホストが見つかりません。再試行中…');
      } else {
        handlers.onStatus('通信エラー(' + (t || 'unknown') + ')。再試行中…');
      }
    });
  }

  function startGuestRetry() {
    if (role !== 'guest' || guestTimer) return;
    guestTimer = setInterval(() => {
      if (role !== 'guest') { stopGuestTimer(); return; }
      attempts += 1;
      handlers.onRetry(attempts);
      attemptGuestConnect();
    }, GUEST_RETRY_MS);
  }

  function attemptGuestConnect() {
    if (role !== 'guest' || !hostId) return;
    if (conn && conn.open) return;
    if (!peer || peer.destroyed) { openGuestPeer(); return; }
    if (peer.disconnected) {
      try { peer.reconnect(); } catch (e) { /* noop */ }
      return;
    }
    if (!peer.open) return;

    const now = Date.now();
    if (pending) {
      if (now - pendingSince < CONNECT_TIMEOUT_MS) return;
      const old = pending;
      pending = null;
      try { old.close(); } catch (e) { /* noop */ }
    }
    let c = null;
    try {
      c = peer.connect(hostId, { reliable: true, serialization: 'json' });
    } catch (e) {
      c = null;
    }
    if (!c) return;
    pending = c;
    pendingSince = now;
    setupConn(c);
  }

  // ---------- 共通: データ接続 ----------
  function setupConn(c) {
    c.on('open', () => onConnOpen(c));
    c.on('data', (d) => onConnData(c, d));
    c.on('close', () => onConnClosed(c, 'close'));
    c.on('error', () => onConnClosed(c, 'error'));
  }

  function onConnOpen(c) {
    if (role === 'host' && conn && conn !== c) {
      // 再接続したゲストの新しい接続で置き換える (古い接続は無視)
      const old = conn;
      conn = null;
      try { old.close(); } catch (e) { /* noop */ }
    }
    if (c === pending) pending = null;
    conn = c;
    lastRx = Date.now();
    lastBeat = lastRx;
    attempts = 0;
    stopGuestTimer();
    startHeartbeat();
    const reconnect = everConnected;
    everConnected = true;
    handlers.onStatus('接続しました');
    handlers.onConnected({ reconnect });
  }

  function onConnData(c, d) {
    if (c !== conn) return;
    lastRx = Date.now();
    if (!d || typeof d !== 'object') return;
    if (d.type === 'ping') {
      send({ type: 'pong', t: d.t });
      return;
    }
    if (d.type === 'pong') {
      const rtt = Date.now() - d.t;
      if (rtt >= 0 && rtt < 10000) {
        const oneWay = rtt / 2;
        latency = latency ? latency * 0.7 + oneWay * 0.3 : oneWay;
      }
      return;
    }
    handlers.onData(d);
  }

  function onConnClosed(c, reason) {
    if (c === pending) { pending = null; return; }
    if (c !== conn) return; // 置き換え済みの古い接続
    conn = null;
    stopHeartbeat();
    handlers.onStatus('接続が切断されました');
    handlers.onDisconnected(reason);
    if (role === 'guest') {
      attempts = 0;
      startGuestRetry();
      setTimeout(attemptGuestConnect, 500);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!conn) return;
      const now = Date.now();
      // 自端末のタイマーが停止していた(バックグラウンド等)場合は誤検知を避ける
      if (now - lastBeat > HEARTBEAT_MS * 3) {
        lastRx = now;
      }
      lastBeat = now;
      if (now - lastRx > DEAD_MS) {
        const c = conn;
        try { c.close(); } catch (e) { /* noop */ }
        onConnClosed(c, 'timeout');
        return;
      }
      send({ type: 'ping', t: now });
    }, HEARTBEAT_MS);
  }

  /** メッセージ送信。成功なら true。 */
  function send(msg) {
    if (!conn || !conn.open) return false;
    try {
      conn.send(msg);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- localStorage ----------
  function saveSession(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* 容量超過/プライベートモード等は無視 */ }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
  }

  return {
    init,
    createRoom,
    joinRoom,
    close,
    send,
    getJoinUrl,
    getLatency: () => latency,
    getRole: () => role,
    getHostId: () => hostId,
    isConnected: () => !!(conn && conn.open),
    saveSession,
    loadSession,
    clearSession,
  };
})();

window.PeerManager = PeerManager;
