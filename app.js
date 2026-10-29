/**
 * app.js
 * ------------------------------------------------------------
 * カードゲーム用チェスクロック本体
 *
 *  - タイマー計算 (Date.now() の差分から算出。毎秒の送受信はしない)
 *  - 画面描画 / イベント処理
 *  - Screen Wake Lock
 *  - Web Audio (確認音・アラーム) / バイブレーション
 *  - 状態遷移イベントの送受信 (PeerManager 経由)
 *  - localStorage による対局状態の保存・復元
 *
 * プレイヤー番号: 1 = ホスト(P1), 2 = ゲスト(P2)。先攻はホストが開始前に選択 (firstPlayer)
 * ------------------------------------------------------------
 */
(() => {
  'use strict';

  // ============================================================
  // 定数・ユーティリティ
  // ============================================================
  const TICK_MS = 100;               // 描画・判定周期
  const PERSIST_INTERVAL_MS = 2000;  // 実行中の定期保存間隔
  const ALARM_MAX_MS = 12000;        // アラーム最大鳴動時間
  const WARN_MS = 60 * 1000;         // 黄色警告
  const DANGER_MS = 10 * 1000;       // 赤点滅警告
  const MAX_LATENCY_COMP_MS = 1500;  // 遅延補正の上限

  const $ = (id) => document.getElementById(id);
  const other = (p) => (p === 1 ? 2 : 1);
  const usedOf = (st, p) => (p === 1 ? st.p1Used : st.p2Used);
  const setUsed = (st, p, v) => {
    if (p === 1) st.p1Used = v; else st.p2Used = v;
  };
  const pad2 = (n) => String(n).padStart(2, '0');

  /** 残り時間表示 (切り上げ) mm:ss */
  function fmtRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  /** 経過時間表示 (切り捨て) mm:ss */
  function fmtElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  /**
   * 持ち時間は「1ゲーム全体」で両者が共有する。
   * remaining は共有の残り時間で、手番に関係なく running 中は常に減る。
   * p1Used / p2Used は各プレイヤーが消費した時間の累計 (振り返り用)。
   */
  function createInitialState(initialMs) {
    return {
      status: 'ready',            // ready | running | paused | timeout
      activePlayer: 1,
      timestamp: Date.now(),      // remaining・pXUsed・turnElapsed が有効な基準時刻 (ローカル時計)
      remaining: initialMs,       // 共有の残り時間 (1ゲーム全体)
      p1Used: 0,                  // P1 の累計消費
      p2Used: 0,                  // P2 の累計消費


      currentTurnNumber: 1,
      turnElapsed: 0,             // timestamp 時点での現ターン消費時間
      turnHistory: [],            // {turn, player, duration, remaining, p1Used, p2Used} (ターン終了時点)
      initialTime: initialMs,
      loser: null,                // 時間切れ時は 'both' (共有時間のため両者時間切れ)
    };
  }

  // ============================================================
  // アプリ状態
  // ============================================================
  let role = null;          // 'host' | 'guest'
  let myPlayer = 1;
  let state = createInitialState(25 * 60 * 1000);
  let connected = false;    // データ接続が確立しているか
  let synced = false;       // 最新ステートの同期が完了しているか
  let screen = 'setup';     // 'setup' | 'main'
  let hostId = null;
  let retryCount = 0;
  let lastPersist = 0;
  let selectedPreset = '1500';
  let shownQrUrl = null;
  let toastTimer = null;
  let firstPlayer = 1;      // 先攻プレイヤー (ホストが開始前に選択。既定はホスト=1)

  // ============================================================
  // Web Audio / バイブレーション
  // ============================================================
  let audioCtx = null;
  let alarmTimer = null;
  let alarmStopTimer = null;

  /** AudioContext 生成 & resume (ユーザー操作内で呼ぶ) */
  function unlockAudio() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().then(updateAudioHint).catch(() => {});
      }
    } catch (e) { /* 音が使えない環境は無視 */ }
    updateAudioHint();
  }

  function updateAudioHint() {
    const hint = $('audio-hint');
    if (!hint) return;
    const ready = audioCtx && audioCtx.state === 'running';
    hint.classList.toggle('is-hidden', !(screen === 'main' && !ready));
  }

  function beep(freq, duration, type, volume, delay) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    try {
      const t0 = audioCtx.currentTime + (delay || 0);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume || 0.25, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) { /* noop */ }
  }

  /** 手番交代の確認音 (短い高めのビープ) */
  function playTurnBeep() {
    beep(1320, 0.14, 'sine', 0.3, 0);
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) { /* noop */ }
  }

  function startAlarm() {
    stopAlarm();
    document.body.classList.add('alarm-flash');
    const ring = () => {
      beep(880, 0.25, 'square', 0.3, 0);
      beep(660, 0.25, 'square', 0.3, 0.3);
      vibrate([200, 100, 200]);
    };
    ring();
    alarmTimer = setInterval(ring, 1000);
    alarmStopTimer = setTimeout(stopAlarm, ALARM_MAX_MS);
  }

  function stopAlarm() {
    if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
    if (alarmStopTimer) { clearTimeout(alarmStopTimer); alarmStopTimer = null; }
    document.body.classList.remove('alarm-flash');
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) { /* noop */ }
  }

  // ============================================================
  // Screen Wake Lock
  // ============================================================
  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    if (wakeLock && !wakeLock.released) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { /* 復帰時に再取得 */ });
    } catch (e) {
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      tick();
    }
  });

  // ============================================================
  // タイマー計算
  // ============================================================
  /** 現在時刻 now における共有残り時間・各プレイヤー累計消費・現ターン経過を算出 */
  function live(now) {
    let rem = state.remaining;
    let u1 = state.p1Used;
    let u2 = state.p2Used;
    let turn = state.turnElapsed;
    if (state.status === 'running') {
      // 共有時間を超えて消費しないよう、経過は残り時間で頭打ちにする
      const d = Math.min(Math.max(0, now - state.timestamp), Math.max(0, rem));
      turn += d;
      rem -= d;
      if (state.activePlayer === 1) u1 += d; else u2 += d;
    }
    return { remaining: Math.max(0, rem), p1Used: u1, p2Used: u2, turn };
  }

  /** 実行中なら現在値を state に確定させて paused にする (ローカルのみ) */
  function freezeToPaused(now) {
    if (state.status !== 'running') return;
    const l = live(now);
    state.remaining = l.remaining;
    state.p1Used = l.p1Used;
    state.p2Used = l.p2Used;
    state.turnElapsed = l.turn;
    state.timestamp = now;
    state.status = 'paused';
  }

  /** 保存データを savedAt 時点で凍結した状態へ変換 (復元用) */
  function freezeSaved(saved, savedAt) {
    const st = JSON.parse(JSON.stringify(saved));
    if (st.status === 'running') {
      const d = Math.min(Math.max(0, savedAt - st.timestamp), Math.max(0, st.remaining));
      st.turnElapsed += d;
      st.remaining = Math.max(0, st.remaining - d);
      if (st.activePlayer === 1) st.p1Used += d; else st.p2Used += d;
      st.status = 'paused';
    }
    st.timestamp = Date.now();
    return st;
  }

  // ============================================================
  // 操作可否
  // ============================================================
  const canAct = () => connected && synced;
  const canEndTurn = () => canAct() && state.status === 'running' && state.activePlayer === myPlayer;
  const canPause = () => canAct() && state.status === 'running';
  const canResume = () => canAct() && state.status === 'paused';
  const canUndo = () => canAct() && (state.status === 'running' || state.status === 'paused') && state.turnHistory.length > 0;
  const canReset = () => canAct() && state.status !== 'ready';

  // ============================================================
  // 状態遷移アクション (ローカル適用 → 送信)
  // ============================================================
  function buildMessage(type) {
    return {
      type,
      activePlayer: state.activePlayer,
      timestamp: Date.now(),
      remaining: state.remaining,
      p1Used: state.p1Used,
      p2Used: state.p2Used,
      currentTurnNumber: state.currentTurnNumber,
      turnHistory: state.turnHistory,
      // 以下は再現に必要な補助項目
      status: state.status,
      turnElapsed: state.turnElapsed,
      initialTime: state.initialTime,
      loser: state.loser,
    };
  }

  function commit(type) {
    persist(true);
    PeerManager.send(buildMessage(type));
    render();
  }

  function startGame() {
    if (role !== 'host' || state.status !== 'ready' || !canAct()) return;
    const now = Date.now();
    state.status = 'running';
    state.activePlayer = firstPlayer;
    state.remaining = state.initialTime;
    state.p1Used = 0;
    state.p2Used = 0;
    state.currentTurnNumber = 1;
    state.turnElapsed = 0;
    state.turnHistory = [];
    state.loser = null;
    state.timestamp = now;
    playTurnBeep();
    vibrate(50);
    commit('start');
  }

  function endTurn() {
    if (!canEndTurn()) return;
    const now = Date.now();
    const l = live(now);
    const act = state.activePlayer;
    state.turnHistory = state.turnHistory.concat([{
      turn: state.currentTurnNumber,
      player: act,
      duration: l.turn,
      remaining: l.remaining,
      p1Used: l.p1Used,
      p2Used: l.p2Used,
    }]);
    state.remaining = l.remaining;
    state.p1Used = l.p1Used;
    state.p2Used = l.p2Used;
    state.activePlayer = other(act);
    state.currentTurnNumber += 1;
    state.turnElapsed = 0;
    state.timestamp = now;
    vibrate(50);
    playTurnBeep();
    commit('turn');
  }

  function pauseGame() {
    if (!canPause()) return;
    freezeToPaused(Date.now());
    commit('pause');
  }

  function resumeGame() {
    if (!canResume()) return;
    state.status = 'running';
    state.timestamp = Date.now();
    commit('resume');
  }

  function undoTurn() {
    if (!canUndo()) return;
    const now = Date.now();
    const hist = state.turnHistory.slice();
    const e = hist.pop();
    state.remaining = e.remaining + e.duration;
    state.p1Used = e.p1Used;
    state.p2Used = e.p2Used;
    // ターン終了時点の値に、そのターンの消費時間を戻す
    setUsed(state, e.player, Math.max(0, usedOf(state, e.player) - e.duration));
    state.activePlayer = e.player;
    state.currentTurnNumber = e.turn;
    state.turnElapsed = e.duration;
    state.turnHistory = hist;
    state.loser = null;
    state.timestamp = now;
    showToast('1手戻しました');
    commit('undo');
  }

  function resetGame() {
    if (!canReset()) return;
    stopAlarm();
    closeModal('modal-timeout');
    state = createInitialState(state.initialTime);
    commit('reset');
  }

  // ============================================================
  // 時間切れ
  // ============================================================
  function handleTimeout(now) {
    const act = state.activePlayer;
    // 共有時間の残りをすべて現手番プレイヤーの消費として確定
    const duration = state.turnElapsed + state.remaining;
    const l = live(now);
    state.turnHistory = state.turnHistory.concat([{
      turn: state.currentTurnNumber,
      player: act,
      duration,
      remaining: 0,
      p1Used: act === 1 ? state.p1Used + state.remaining : state.p1Used,
      p2Used: act === 2 ? state.p2Used + state.remaining : state.p2Used,
    }]);
    setUsed(state, act, usedOf(state, act) + state.remaining);
    state.remaining = 0;
    state.turnElapsed = duration;
    state.status = 'timeout';
    state.loser = 'both'; // 共有時間のため両者時間切れ
    state.timestamp = now;
    persist(true);
    startAlarm();
    showTimeoutModal();
    render();
  }

  function showTimeoutModal() {
    // 持ち時間は両者共有のため、時間切れは常に両者の時間切れ
    $('timeout-title').textContent = '時間切れ（両者）';
    $('timeout-detail').textContent =
      '1ゲームの持ち時間が0になりました。' +
      '両者とも時間切れです。';
    openModal('modal-timeout');
  }

  // ============================================================
  // 受信処理
  // ============================================================
  function adoptRemote(msg) {
    const lat = msg.status === 'running'
      ? Math.min(Math.max(PeerManager.getLatency(), 0), MAX_LATENCY_COMP_MS)
      : 0;
    state = {
      status: msg.status || 'paused',
      activePlayer: msg.activePlayer === 2 ? 2 : 1,
      // 受信側は自分の時計を基準に再構築 (送信側と時計がズレていても影響しない)
      timestamp: Date.now() - lat,
      remaining: Math.max(0, Number(msg.remaining) || 0),
      p1Used: Number(msg.p1Used) || 0,
      p2Used: Number(msg.p2Used) || 0,
      currentTurnNumber: Number(msg.currentTurnNumber) || 1,
      turnElapsed: Number(msg.turnElapsed) || 0,
      turnHistory: Array.isArray(msg.turnHistory) ? msg.turnHistory : [],
      initialTime: Number(msg.initialTime) || state.initialTime,
      loser: msg.loser || null,
    };
  }

  function onData(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'hello': // ゲストの接続/再接続 → ホストが最新ステートを再送
        if (role !== 'host') return;
        if (state.status === 'running') freezeToPaused(Date.now());
        persist(true);
        PeerManager.send(buildMessage('sync'));
        render();
        return;

      case 'ack': // ゲストが同期を完了
        if (role === 'host') {
          synced = true;
          render();
        }
        return;

      case 'sync':
        if (role !== 'guest') return;
        adoptRemote(msg);
        synced = true;
        PeerManager.send({ type: 'ack' });
        if (screen !== 'main') showScreen('main');
        if (state.status === 'timeout') showTimeoutModal();
        persist(true);
        render();
        return;

      case 'start':
      case 'turn':
      case 'pause':
      case 'resume':
      case 'undo':
      case 'reset': {
        if (!synced) return;
        // 自端末で時間切れ確定済みの場合は、リセット以外の遷移を無視
        if (state.status === 'timeout' && msg.type !== 'reset') return;
        adoptRemote(msg);
        if (msg.type === 'start' || msg.type === 'turn') playTurnBeep();
        if (msg.type === 'reset') {
          stopAlarm();
          closeModal('modal-timeout');
        }
        if (msg.type === 'undo') showToast('相手が1手戻しました');
        persist(true);
        render();
        return;
      }
      default:
        return;
    }
  }

  // ============================================================
  // 接続イベント (PeerManager)
  // ============================================================
  PeerManager.init({
    onRoomReady: (id) => {
      hostId = id;
      showHostShare(id);
    },

    onConnected: () => {
      connected = true;
      synced = false;
      retryCount = 0;
      requestWakeLock();
      if (state.status === 'running') freezeToPaused(Date.now()); // 取りこぼし切断への保険
      if (role === 'host') {
        if (screen !== 'main') showScreen('main');
      } else {
        PeerManager.send({ type: 'hello' });
      }
      persist(true);
      render();
    },

    onDisconnected: () => {
      connected = false;
      synced = false;
      // 強制一時停止
      if (state.status === 'running') freezeToPaused(Date.now());
      persist(true);
      render();
    },

    onStatus: (text) => {
      document.querySelectorAll('#host-wait-status .status-text, #guest-wait-status .status-text')
        .forEach((el) => { el.textContent = text; });
    },

    onRetry: (n) => {
      retryCount = n;
      render();
    },

    onError: (text) => {
      showToast(text, 5000);
      $('conn-detail').textContent = text;
    },
  });

  // ============================================================
  // 画面遷移
  // ============================================================
  function showScreen(name) {
    screen = name;
    $('screen-setup').classList.toggle('is-hidden', name !== 'setup');
    $('screen-main').classList.toggle('is-hidden', name !== 'main');
    updateAudioHint();
    if (name === 'main') requestWakeLock();
    render();
  }

  function setSetupMode(mode) {
    $('setup-choice').classList.toggle('is-hidden', mode !== 'choice');
    $('setup-host-wait').classList.toggle('is-hidden', mode !== 'host-wait');
    $('setup-guest-wait').classList.toggle('is-hidden', mode !== 'guest-wait');
  }

  function renderQr(container, url) {
    container.innerHTML = '';
    if (typeof QRCode === 'undefined') {
      container.style.lineHeight = '1.4';
      container.style.color = '#0f172a';
      container.textContent = 'QRコードを生成できません。URLを共有してください。';
      return;
    }
    new QRCode(container, {
      text: url,
      width: 176,
      height: 176,
      colorDark: '#0f172a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  function showHostShare(id) {
    const url = PeerManager.getJoinUrl(id);
    $('host-url').textContent = url;
    $('conn-url').textContent = url;
    if (shownQrUrl !== url) {
      renderQr($('host-qr'), url);
      renderQr($('conn-qr'), url);
      shownQrUrl = url;
    }
    if (screen === 'setup') setSetupMode('host-wait');
  }

  function showToast(text, ms) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  function openModal(id) { $(id).classList.remove('is-hidden'); }
  function closeModal(id) { $(id).classList.add('is-hidden'); }

  // ============================================================
  // 描画
  // ============================================================
  function panelStateFor(player) {
    if (state.status === 'ready') return 'ready';
    if (state.status === 'timeout') return 'lose';
    const isActive = state.activePlayer === player;
    if (state.status === 'paused') return isActive ? 'paused' : 'waiting';
    return isActive ? 'active' : 'waiting';
  }

  function applyTimeClass(el, remaining) {
    const started = state.status !== 'ready';
    el.classList.toggle('time-danger', started && remaining <= DANGER_MS);
    el.classList.toggle('time-warn', started && remaining > DANGER_MS && remaining <= WARN_MS);
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function render() {
    updateConnectionUi();
    if (screen !== 'main') return;

    const now = Date.now();
    const l = live(now);
    const me = myPlayer;
    const opp = other(me);
    const rem = l.remaining;


    setText($('my-time'), fmtRemaining(rem));
    setText($('opp-time'), fmtRemaining(rem));
    applyTimeClass($('my-time'), rem);
    applyTimeClass($('opp-time'), rem);

    setText($('turn-label'), 'TURN ' + state.currentTurnNumber);
    setText($('my-label'), 'あなた（P' + me + (me === 1 ? '・ホスト' : '・ゲスト') + '）');
    setText($('opp-label'), '相手（P' + opp + '）');

    // パネル状態
    const myPanel = $('my-btn');
    const oppPanel = $('opp-panel');
    const myState = panelStateFor(me);
    const oppState = panelStateFor(opp);
    if (myPanel.dataset.state !== myState) myPanel.dataset.state = myState;
    if (oppPanel.dataset.state !== oppState) oppPanel.dataset.state = oppState;

    // サブ表示: 手番側は「現ターン消費」「累計消費」、待機側は累計のみ
    const subFor = (player) => {
      const used = player === 1 ? l.p1Used : l.p2Used;
      const total = fmtElapsed(used);
      if (state.status !== 'ready' && state.activePlayer === player) {
        return '今ターン ' + fmtElapsed(l.turn) + '  ／  累計 ' + total;
      }
      return state.status === 'ready' ? '\u00a0' : '累計 ' + total;
    };
    setText($('my-sub'), subFor(me));
    setText($('opp-sub'), subFor(opp));

    renderMainButton();

    // 先攻選択 (ホストのみ・開始前のみ)
    const fs = $('first-select');
    fs.classList.toggle('is-hidden', !(role === 'host' && state.status === 'ready'));
    $('first-me').setAttribute('aria-pressed', firstPlayer === 1 ? 'true' : 'false');
    $('first-opp').setAttribute('aria-pressed', firstPlayer === 2 ? 'true' : 'false');

    // サブメニュー
    const pauseBtn = $('btn-pause');
    const isPaused = state.status === 'paused';
    setText($('btn-pause-text'), isPaused ? '再開' : '一時停止');
    pauseBtn.querySelector('.tool-ico').textContent = isPaused ? '▶' : '⏸';
    pauseBtn.disabled = !(canPause() || canResume());
    $('btn-undo').disabled = !canUndo();
    $('btn-reset').disabled = !canReset();
  }

  function renderMainButton() {
    const btn = $('my-btn');
    let text;
    let enabled;
    let kind;

    switch (state.status) {
      case 'ready':
        if (role === 'host') {
          text = '対局開始';
          enabled = canAct();
          kind = enabled ? 'end' : 'wait';
        } else {
          text = 'ホストの開始待ち';
          enabled = false;
          kind = 'wait';
        }
        break;
      case 'running':
        if (state.activePlayer === myPlayer) {
          text = 'ターンエンド';
          enabled = canEndTurn();
          kind = enabled ? 'end' : 'lock';
        } else {
          text = '相手の手番';
          enabled = false;
          kind = 'lock';
        }
        break;
      case 'paused':
        text = '再開';
        enabled = canResume();
        kind = enabled ? 'resume' : 'lock';
        break;
      case 'timeout':
        text = state.loser === myPlayer ? '時間切れ' : '相手の時間切れ';
        enabled = false;
        kind = 'lock';
        break;
      default:
        text = '';
        enabled = false;
        kind = 'wait';
    }

    setText($('my-action'), text);
    btn.disabled = !enabled;
    if (btn.dataset.kind !== kind) btn.dataset.kind = kind;
  }

  function updateConnectionUi() {
    const ok = connected && synced;
    const pill = $('conn-pill');
    pill.dataset.ok = ok ? 'true' : 'false';
    setText($('conn-pill-text'), ok ? '接続中' : (connected ? '同期中' : '切断'));

    // 再接続オーバーレイ
    const needOverlay = screen === 'main' && (!connected || (!synced && state.status === 'paused'));
    $('conn-overlay').classList.toggle('is-hidden', !needOverlay);
    if (!needOverlay) return;

    const isHost = role === 'host';
    $('conn-share').classList.toggle('is-hidden', !(isHost && hostId));
    if (!connected) {
      $('conn-title').textContent = '接続が切断されました';
      $('conn-detail').textContent = isHost
        ? 'ゲストの再接続を待っています…'
        : 'ホストへ再接続しています…' + (retryCount > 0 ? '（試行 ' + retryCount + ' 回目）' : '');
    } else {
      $('conn-title').textContent = '同期中';
      $('conn-detail').textContent = '最新の対局状態を同期しています…';
    }
  }

  // ============================================================
  // 毎フレームループ
  // ============================================================
  function tick() {
    const now = Date.now();
    if (state.status === 'running') {
      const active = state.activePlayer;
      const rem = live(now);

      if (rem.remaining <= 0) {
        handleTimeout(now);
        return;
      }
      if (now - lastPersist > PERSIST_INTERVAL_MS) persist(false);
    }
    render();
  }

  setInterval(tick, TICK_MS);

  // ============================================================
  // localStorage 連携
  // ============================================================
  function persist(force) {
    if (screen !== 'main' || !role) return;
    const now = Date.now();
    if (!force && now - lastPersist < PERSIST_INTERVAL_MS) return;
    lastPersist = now;
    PeerManager.saveSession({
      v: 1,
      role,
      hostId,
      state,
      savedAt: now,
    });
  }

  window.addEventListener('pagehide', () => persist(true));

  function refreshRestoreCard() {
    const s = PeerManager.loadSession();
    const card = $('restore-card');
    const valid = s && s.state && s.role && s.hostId && s.state.status && s.state.status !== 'ready';
    card.classList.toggle('is-hidden', !valid);
    if (valid) {
      const when = new Date(s.savedAt || Date.now());
      const st = s.state;
      $('restore-info').textContent =
        (s.role === 'host' ? 'ホスト' : 'ゲスト') + ' ／ TURN ' + st.currentTurnNumber +
        ' ／ 残り ' + fmtRemaining(st.remaining ?? st.initialTime) +
        ' ／ 保存 ' + pad2(when.getHours()) + ':' + pad2(when.getMinutes());
    }
  }

  function restoreSession() {
    const s = PeerManager.loadSession();
    if (!s || !s.state || !s.hostId) return;
    role = s.role === 'guest' ? 'guest' : 'host';
    myPlayer = role === 'host' ? 1 : 2;
    hostId = s.hostId;
    state = freezeSaved(s.state, s.savedAt || Date.now());
    connected = false;
    synced = false;
    retryCount = 0;
    showScreen('main');
    if (role === 'host') {
      PeerManager.createRoom(s.hostId); // 同じIDで再取得 → ゲストは同じURLで再参加可
    } else {
      PeerManager.joinRoom(s.hostId);
    }
    if (state.status === 'timeout') showTimeoutModal();
  }

  // ============================================================
  // 設定画面の操作
  // ============================================================
  function getSelectedSeconds() {
    if (selectedPreset === 'custom') {
      const v = Number($('custom-sec').value);
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 10 || v > 36000) return null;
      return v;
    }
    return Number(selectedPreset);
  }

  function createRoom() {
    unlockAudio();
    requestWakeLock();
    const sec = getSelectedSeconds();
    const err = $('setup-error');
    if (sec === null) {
      err.textContent = '持ち時間は10〜36000秒の整数で入力してください。';
      err.classList.remove('is-hidden');
      return;
    }
    err.classList.add('is-hidden');

    role = 'host';
    myPlayer = 1;
    connected = false;
    synced = false;
    shownQrUrl = null;
    state = createInitialState(sec * 1000);
    setSetupMode('host-wait');
    $('host-url').textContent = '';
    $('host-qr').innerHTML = '';
    PeerManager.createRoom(null);
  }

  function joinRoom(targetId) {
    unlockAudio();
    requestWakeLock();
    role = 'guest';
    myPlayer = 2;
    hostId = targetId;
    connected = false;
    synced = false;
    retryCount = 0;
    $('guest-target').textContent = 'ルームID: ' + targetId;
    setSetupMode('guest-wait');
    PeerManager.joinRoom(targetId);
  }

  function parseJoinInput(raw) {
    const text = (raw || '').trim();
    if (!text) return '';
    const m = text.match(/[?&]join=([^&#\s]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    return text;
  }

  function leaveToSetup() {
    PeerManager.close();
    stopAlarm();
    closeModal('modal-timeout');
    role = null;
    connected = false;
    synced = false;
    hostId = null;
    showScreen('setup');
    setSetupMode('choice');
    refreshRestoreCard();
  }

  // ============================================================
  // ログ表示
  // ============================================================
  /** ログ用のプレイヤー表記: P1=ホスト / P2=ゲスト */
  function roleLabel(p) {
    return (p === 1 ? 'ホスト' : 'ゲスト') + '・P' + p;
  }

  function renderLog() {
    const body = $('log-body');
    body.innerHTML = '';
    const hist = state.turnHistory;
    $('log-empty').classList.toggle('is-hidden', hist.length > 0);

    const totals = { 1: 0, 2: 0 };
    const counts = { 1: 0, 2: 0 };
    hist.forEach((h) => {
      totals[h.player] += h.duration;
      counts[h.player] += 1;
      const tr = document.createElement('tr');
      const isMe = h.player === myPlayer;
      tr.className = isMe ? 'row-me' : 'row-opp';
      const remain = h.remaining != null ? h.remaining : (h.player === 1 ? h.p1Remaining : h.p2Remaining);
      const cells = [
        { text: String(h.turn) },
        { text: (isMe ? 'あなた' : '相手') + '（' + roleLabel(h.player) + '）', cls: 'who' },
        { text: fmtElapsed(h.duration) },
        { text: fmtRemaining(remain) },
      ];
      cells.forEach((c) => {
        const td = document.createElement('td');
        td.textContent = c.text;
        if (c.cls) td.className = c.cls;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });

    const summary = $('log-summary');
    summary.innerHTML = '';
    [myPlayer, other(myPlayer)].forEach((p) => {
      const div = document.createElement('div');
      div.className = 'sum-card';
      const avg = counts[p] ? totals[p] / counts[p] : 0;
      div.innerHTML = '';
      const title = document.createElement('p');
      title.className = 'font-bold ' + (p === myPlayer ? 'text-emerald-700' : 'text-sky-700');
      title.textContent = (p === myPlayer ? 'あなた' : '相手') + '（' + roleLabel(p) + '）';
      const info = document.createElement('p');
      info.className = 'mt-1 font-mono text-stone-700';
      info.textContent = '計 ' + fmtElapsed(totals[p]) + ' ／ 平均 ' + fmtElapsed(avg);
      div.appendChild(title);
      div.appendChild(info);
      summary.appendChild(div);
    });

    // 最新行が見えるよう末尾へスクロール
    const sc = body.closest('.log-scroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  function openLog() {
    renderLog();
    openModal('modal-log');
    const sc = $('log-body').closest('.log-scroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  // ============================================================
  // イベント登録
  // ============================================================
  function bindEvents() {
    // ブラウザの自動再生制限対策: 最初のタッチで AudioContext をアンロック
    document.addEventListener('pointerdown', () => {
      unlockAudio();
      requestWakeLock();
    }, { passive: true });
    $('audio-hint').addEventListener('click', unlockAudio);

    // ピンチ・ダブルタップズームの抑止 (iOS Safari)
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => {
      document.addEventListener(ev, (e) => e.preventDefault());
    });
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const t = Date.now();
      if (t - lastTouchEnd <= 300 && e.target.closest && !e.target.closest('input')) {
        e.preventDefault();
      }
      lastTouchEnd = t;
    }, { passive: false });

    // 持ち時間プリセット
    document.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        selectedPreset = chip.dataset.sec;
        document.querySelectorAll('.chip').forEach((c) => {
          c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
        });
        $('custom-wrap').classList.toggle('is-hidden', selectedPreset !== 'custom');
        $('setup-error').classList.add('is-hidden');
      });
    });

    $('btn-create').addEventListener('click', createRoom);

    $('btn-join').addEventListener('click', () => {
      const id = parseJoinInput($('join-input').value);
      if (!id) { showToast('URLまたはルームIDを入力してください'); return; }
      joinRoom(id);
    });

    $('btn-copy').addEventListener('click', async () => {
      const url = $('host-url').textContent;
      try {
        await navigator.clipboard.writeText(url);
        showToast('参加URLをコピーしました');
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents($('host-url'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        showToast('URLを選択しました。コピーしてください');
      }
    });

    $('btn-cancel-host').addEventListener('click', leaveToSetup);
    $('btn-cancel-guest').addEventListener('click', leaveToSetup);
    $('btn-restore').addEventListener('click', () => {
      unlockAudio();
      restoreSession();
    });
    $('btn-conn-leave').addEventListener('click', leaveToSetup);

    // メイン操作ボタン
    $('first-me').addEventListener('click', () => { firstPlayer = 1; render(); });
    $('first-opp').addEventListener('click', () => { firstPlayer = 2; render(); });

    $('my-btn').addEventListener('click', () => {
      unlockAudio();
      switch (state.status) {
        case 'ready': startGame(); break;
        case 'running': endTurn(); break;
        case 'paused': resumeGame(); break;
        default: break;
      }
    });

    // サブメニュー
    $('btn-pause').addEventListener('click', () => {
      if (state.status === 'paused') resumeGame(); else pauseGame();
    });
    $('btn-undo').addEventListener('click', undoTurn);
    $('btn-log').addEventListener('click', openLog);
    $('btn-help').addEventListener('click', () => openModal('modal-help'));
    $('btn-help-setup').addEventListener('click', () => openModal('modal-help'));
    $('btn-reset').addEventListener('click', () => openModal('modal-reset'));
    $('btn-reset-ok').addEventListener('click', () => {
      closeModal('modal-reset');
      resetGame();
    });

    // 時間切れモーダル
    $('btn-timeout-close').addEventListener('click', () => {
      stopAlarm();
      closeModal('modal-timeout');
    });
    $('btn-timeout-log').addEventListener('click', () => {
      stopAlarm();
      closeModal('modal-timeout');
      openLog();
    });
    $('btn-timeout-reset').addEventListener('click', resetGame);

    // モーダル閉じる
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => closeModal(el.dataset.close));
    });
    ['modal-help', 'modal-log', 'modal-reset'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        if (e.target === $(id)) closeModal(id);
      });
    });
  }

  // ============================================================
  // 初期化
  // ============================================================
  function init() {
    bindEvents();
    PeerManager.init({ onData });
    refreshRestoreCard();
    showScreen('setup');

    // ?join=HOST_PEER_ID でアクセスした場合は自動接続
    const params = new URLSearchParams(location.search);
    const joinId = params.get('join');
    if (joinId) {
      joinRoom(joinId);
    } else {
      setSetupMode('choice');
    }
  }

  init();
})();
