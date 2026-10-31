/* piltonTv — sala de voz + compartilhamento de tela, 100% no navegador.
 *
 * Como funciona:
 *  - Cada pessoa tem um Peer (PeerJS) com id aleatório: piltontv-<sala>-<aleatório>.
 *  - Uma das pessoas também segura o id "piltontv-<sala>-hub" (o "lobby").
 *    Quem chega pergunta ao lobby quem já está na sala e conecta direto em todo mundo.
 *    Se quem segura o lobby sair, outra pessoa assume sozinha.
 *  - Voz e tela vão direto de navegador para navegador (WebRTC), sem servidor no meio.
 *  - Chat e estados (mutado, compartilhando...) vão por canais de dados diretos.
 */
(() => {
  'use strict';

  const PREFIX = 'piltontv';
  const SYNC_MS = 9000;
  const PING_MS = 4000;     // cada um avisa "ainda estou aqui" a cada 4s
  const STALE_MS = 20000;   // sem notícia por 20s = saiu (aba fechada, internet caiu...)

  const $ = (s) => document.querySelector(s);

  // ---------- Ícones ----------
  const I = {
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/></svg>',
    micOff: '<svg viewBox="0 0 24 24"><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1M19 10a7 7 0 0 1-1.2 4M5 10a7 7 0 0 0 11.2 5.6M12 17v4M8 21h8M3 3l18 18"/></svg>',
    head: '<svg viewBox="0 0 24 24"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/></svg>',
    headOff: '<svg viewBox="0 0 24 24"><path d="M3 14v-2a9 9 0 0 1 14.5-7.1M21 12v2"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/><path d="M3 3l18 18"/></svg>',
    leave: '<svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    screen: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    stop: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 7l6 6M15 7l-6 6M8 20h8"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
    volOff: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/></svg>',
  };

  // ---------- Estado ----------
  const S = {
    room: '',
    name: '',
    myId: '',
    me: null,            // Peer principal
    hub: null,           // Peer do lobby (se eu estiver segurando)
    isHub: false,
    leaving: false,
    conns: new Map(),    // peerId -> DataConnection atual
    members: new Map(),  // peerId -> { name, muted, deaf, sharing, noMic }
    mic: null,           // MediaStream do microfone
    micMuted: false,
    deaf: false,
    mutedBeforeDeaf: false,
    screen: null,        // MediaStream da minha tela
    outCalls: new Map(), // "voice:<id>" | "screen:<id>" -> MediaConnection que eu iniciei
    inCalls: new Map(),  // "voice:<id>" | "screen:<id>" -> { call, stream }
    levels: new Map(),   // peerId -> { analyser, buf, src }
    audioCtx: null,
    focus: null,         // id do tile em foco
    hubQuery: null,      // callback da consulta ao lobby em andamento
    lastMsgFrom: null,
    joinedAt: 0,
    quality: 'alta',
    uid: '',             // id desta aba; sobrevive a recarregar a página
    lastSeen: new Map(), // peerId -> última vez que chegou algo dele
    volumes: {},         // nome -> volume (0 a 2) que eu escolhi para essa pessoa
    volFor: null,        // peerId com o painel de volume aberto
  };
  try { S.quality = localStorage.getItem('ptv-quality') || 'alta'; } catch {}
  try { S.volumes = JSON.parse(localStorage.getItem('ptv-volumes') || '{}') || {}; } catch {}
  // O id da aba fica no sessionStorage só enquanto a página está fechando, para o recarregamento
  // reaproveitar. Se ficasse lá o tempo todo, "Duplicar guia" copiaria e as duas abas teriam o mesmo id.
  try { S.uid = sessionStorage.getItem('ptv-uid') || ''; sessionStorage.removeItem('ptv-uid'); } catch {}
  if (!S.uid) S.uid = Math.random().toString(36).slice(2, 12);
  window.addEventListener('pagehide', () => { try { sessionStorage.setItem('ptv-uid', S.uid); } catch {} });

  // Logo depois de entrar, quem já estava na sala não deve gerar "fulano entrou" nem som.
  const settling = () => Date.now() - S.joinedAt < 4000;

  const hubId = () => `${PREFIX}-${S.room}-hub`;
  const rand = () => Math.random().toString(36).slice(2, 10);
  const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

  // ---------- Utilidades de UI ----------
  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function colorFor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const palette = ['#5865f2', '#eb459e', '#3ba55c', '#faa61a', '#ed4245', '#9b59b6', '#1abc9c', '#e67e22', '#3498db'];
    return palette[h % palette.length];
  }

  function avatar(name, el = document.createElement('div')) {
    el.classList.add('avatar');
    el.style.background = colorFor(name || '?');
    el.textContent = (name || '?').trim().charAt(0).toUpperCase();
    return el;
  }

  // Sons curtinhos de entrar/sair
  function beep(up) {
    const ctx = S.audioCtx;
    if (!ctx || S.deaf) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(up ? 520 : 660, t);
    o.frequency.exponentialRampToValueAtTime(up ? 780 : 440, t + 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.25);
  }

  // ---------- Entrada ----------
  function initJoin() {
    const params = new URLSearchParams(location.search);
    $('#roomInput').value = params.get('sala') || localStorage.getItem('ptv-room') || 'principal';
    $('#nameInput').value = localStorage.getItem('ptv-name') || '';
    ($('#nameInput').value ? $('#joinBtn') : $('#nameInput')).focus();

    $('#joinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#nameInput').value.trim().slice(0, 24);
      const room = slug($('#roomInput').value) || 'principal';
      if (!name) return;
      $('#joinBtn').disabled = true;
      $('#joinBtn').textContent = 'Entrando...';
      try { localStorage.setItem('ptv-name', name); localStorage.setItem('ptv-room', room); } catch {}
      await join(name, room);
    });
  }

  async function join(name, room) {
    S.name = name;
    S.room = room;
    S.myId = `${PREFIX}-${room}-${rand()}`;
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    try {
      S.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      watchLevel(S.myId, S.mic);
    } catch {
      S.mic = null;
      toast('Sem microfone: você entrou só para ouvir e assistir.');
    }

    S.me = new Peer(S.myId, { debug: 1 });
    S.me.on('open', () => {
      if (S.joinedAt) return; // 'open' dispara de novo depois de reconectar
      S.joinedAt = Date.now();
      showApp();
      sync();
      scheduleSync();
    });
    S.me.on('connection', (conn) => {
      if (conn.metadata && conn.metadata.lobby) return; // não deveria acontecer no peer principal
      adoptConn(conn, false);
    });
    S.me.on('call', onIncomingCall);
    S.me.on('error', onMeError);
    S.me.on('disconnected', () => {
      if (S.leaving || S.me.destroyed) return;
      setTimeout(() => { if (!S.leaving && !S.me.destroyed && S.me.disconnected) S.me.reconnect(); }, 1500);
    });

    history.replaceState(null, '', `?sala=${encodeURIComponent(room)}`);
  }

  function onMeError(err) {
    const msg = String(err && err.message || '');
    if (err.type === 'peer-unavailable') {
      if (msg.includes(hubId()) && S.hubQuery) S.hubQuery('unavailable');
      return; // alguém da lista já saiu; ignorar
    }
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      toast('Problema de conexão com o servidor. Tentando de novo...', 'error');
      return;
    }
    if (err.type === 'browser-incompatible') {
      toast('Seu navegador não suporta chamadas. Use Chrome, Edge ou Firefox.', 'error');
      return;
    }
    console.warn('peer error', err.type, err);
  }

  // ---------- Lobby (descoberta de quem está na sala) ----------
  function scheduleSync() {
    setTimeout(async () => {
      if (S.leaving) return;
      await sync();
      scheduleSync();
    }, SYNC_MS + Math.random() * 3000);
  }

  async function sync() {
    if (S.leaving || S.isHub || !S.me || S.me.disconnected) return;
    const r = await queryHub();
    if (r !== 'ok') await tryClaimHub();
  }

  function queryHub() {
    return new Promise((resolve) => {
      let done = false;
      let conn;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (S.hubQuery === finish) S.hubQuery = null;
        try { conn && conn.close(); } catch {}
        resolve(r);
      };
      S.hubQuery = finish;
      const timer = setTimeout(() => finish('timeout'), 6000);
      conn = S.me.connect(hubId(), { reliable: true, metadata: { lobby: true } });
      conn.on('data', (d) => {
        if (d && d.type === 'members' && Array.isArray(d.ids)) {
          for (const id of d.ids) {
            if (typeof id === 'string' && id !== S.myId && id.startsWith(`${PREFIX}-${S.room}-`) && !S.conns.has(id)) {
              connectTo(id);
            }
          }
          finish('ok');
        }
      });
      conn.on('error', () => finish('error'));
    });
  }

  function tryClaimHub() {
    return new Promise((resolve) => {
      if (S.leaving) return resolve(false);
      const hp = new Peer(hubId(), { debug: 0 });
      let settled = false;
      hp.on('open', () => {
        settled = true;
        S.hub = hp;
        S.isHub = true;
        hp.on('connection', onLobbyConn);
        hp.on('disconnected', dropHub);
        resolve(true);
      });
      hp.on('error', () => {
        if (!settled) {
          settled = true;
          try { hp.destroy(); } catch {}
          resolve(false);
        }
      });
      setTimeout(() => {
        if (!settled) { settled = true; try { hp.destroy(); } catch {} resolve(false); }
      }, 8000);
    });
  }

  function dropHub() {
    if (S.hub) { try { S.hub.destroy(); } catch {} }
    S.hub = null;
    S.isHub = false;
  }

  function onLobbyConn(conn) {
    conn.on('open', () => {
      const ids = [S.myId];
      for (const [id, c] of S.conns) if (c.open && !isStale(id)) ids.push(id);
      conn.send({ type: 'members', ids });
      setTimeout(() => { try { conn.close(); } catch {} }, 2000);
    });
  }

  // ---------- Conexões de dados entre membros ----------
  function connectTo(id) {
    const conn = S.me.connect(id, { reliable: true, metadata: { name: S.name } });
    adoptConn(conn, true);
  }

  function adoptConn(conn, outgoing) {
    const id = conn.peer;
    conn._initiator = outgoing ? S.myId : id;
    conn.on('data', (d) => { if (S.conns.get(id) === conn) S.lastSeen.set(id, Date.now()); onData(id, d); });

    const existing = S.conns.get(id);
    if (existing && existing !== conn) {
      // Conexão duplicada (os dois se conectaram ao mesmo tempo).
      // Os dois lados ficam com a que foi iniciada pelo menor id.
      const winner = S.myId < id ? S.myId : id;
      if (existing._initiator === winner) return;
    }
    S.conns.set(id, conn);

    conn.on('open', () => onConnOpen(conn));
    conn.on('close', () => onConnClose(conn));
    conn.on('error', () => onConnClose(conn));
    if (conn.open) onConnOpen(conn);

    setTimeout(() => {
      if (!conn.open && S.conns.get(id) === conn) onConnClose(conn);
    }, 12000);
  }

  function myState() {
    return {
      type: 'state',
      name: S.name,
      muted: S.micMuted || !S.mic,
      deaf: S.deaf,
      sharing: !!S.screen,
      noMic: !S.mic,
      uid: S.uid,
    };
  }

  function onConnOpen(conn) {
    const id = conn.peer;
    if (S.conns.get(id) !== conn) return;
    S.lastSeen.set(id, Date.now());
    conn.send(myState());
    if (!S.members.has(id)) {
      // O nome real chega na primeira mensagem de 'state'.
      S.members.set(id, { name: '...', muted: false, deaf: false, sharing: false });
      if (S.mic) callPeer(id, 'voice', S.mic);
      if (S.screen) callPeer(id, 'screen', S.screen);
      if (!settling()) beep(true);
      renderMembers();
      applyScreenQuality();
    }
  }

  function onConnClose(conn) {
    const id = conn.peer;
    if (S.conns.get(id) !== conn) return;
    S.conns.delete(id);
    S.lastSeen.delete(id);
    removeMember(id);
  }

  // Tira alguém da sala na hora, sem esperar o navegador perceber que a conexão caiu.
  function dropPeer(id, quiet = false) {
    const conn = S.conns.get(id);
    S.conns.delete(id);
    S.lastSeen.delete(id);
    if (conn) { try { conn.close(); } catch {} }
    removeMember(id, quiet);
  }

  const isStale = (id) => Date.now() - (S.lastSeen.get(id) || 0) > STALE_MS;

  // Batimento: avisa que estou aqui e derruba quem sumiu sem avisar.
  setInterval(() => {
    if (!S.joinedAt || S.leaving) return;
    broadcast({ type: 'ping' });
    for (const [id, c] of [...S.conns]) if (c.open && isStale(id)) dropPeer(id);
  }, PING_MS);

  function removeMember(id, quiet = false) {
    const m = S.members.get(id);
    if (!m) return;
    S.members.delete(id);
    if (S.volFor === id) closeVolume();
    for (const kind of ['voice', 'screen']) {
      const key = `${kind}:${id}`;
      const out = S.outCalls.get(key);
      if (out) { try { out.close(); } catch {} S.outCalls.delete(key); }
      const inc = S.inCalls.get(key);
      if (inc) { try { inc.call.close(); } catch {} S.inCalls.delete(key); }
    }
    detachVoice(id);
    removeTile(id);
    if (!quiet) {
      beep(false);
      systemMsg(`${m.name} saiu`);
    }
    renderMembers();
    applyScreenQuality();
  }

  function broadcast(msg) {
    for (const c of S.conns.values()) if (c.open) { try { c.send(msg); } catch {} }
  }

  function onData(id, d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'state') {
      const m = S.members.get(id);
      if (!m) return;
      const firstName = m.name === '...';
      // A mesma aba voltou com outro id (recarregou a página): some com a entrada antiga.
      if (typeof d.uid === 'string' && d.uid) {
        m.uid = d.uid;
        for (const [oid, om] of [...S.members]) if (oid !== id && om.uid === d.uid) dropPeer(oid, true);
      }
      const prevName = m.name;
      m.name = String(d.name || '?').slice(0, 24);
      if (m.name !== prevName) applyVoiceVolume(id);
      m.muted = !!d.muted;
      m.deaf = !!d.deaf;
      m.noMic = !!d.noMic;
      const wasSharing = m.sharing;
      m.sharing = !!d.sharing;
      if (firstName && !settling()) { systemMsg(`${m.name} entrou`); }
      if (wasSharing && !m.sharing) removeTile(id);
      if (!wasSharing && m.sharing && !firstName) toast(`${m.name} começou a compartilhar a tela`);
      renderMembers();
      updateTileLabel(id);
    } else if (d.type === 'bye') {
      dropPeer(id);
    } else if (d.type === 'chat') {
      const m = S.members.get(id);
      addMessage(m ? m.name : '?', String(d.text || '').slice(0, 500), id);
    }
  }

  // ---------- Qualidade da transmissão ----------
  // kbps[0] = bitrate por pessoa assistindo quando são até 4; kbps[1] = quando são 5 ou mais.
  const QUALITY = {
    leve:   { label: 'Leve · 720p 30fps',    height: 720,  fps: 30, kbps: [2500, 1800], hint: 'detail', deg: 'maintain-resolution' },
    alta:   { label: 'Alta · 1080p 30fps',   height: 1080, fps: 30, kbps: [6000, 4000], hint: 'detail', deg: 'maintain-resolution' },
    fluida: { label: 'Fluida · 1080p 60fps', height: 1080, fps: 60, kbps: [8000, 5000], hint: 'motion', deg: 'balanced' },
  };
  const quality = () => QUALITY[S.quality] || QUALITY.alta;
  const perViewerKbps = () => { const q = quality(); return S.members.size <= 4 ? q.kbps[0] : q.kbps[1]; };

  // Ajustes no SDP:
  //  - vídeo: prefere VP9 (bem mais qualidade por bit que o VP8 padrão), depois AV1/H264
  //  - áudio da tela: Opus estéreo 128 kbps (música/filme), em vez do modo de voz
  function tuneSdp(sdp) {
    const lines = sdp.split('\r\n');
    const rtpmap = {};
    const fmtp = {};
    lines.forEach((l, i) => {
      let m = l.match(/^a=rtpmap:(\d+) ([\w-]+)\//);
      if (m) rtpmap[m[1]] = m[2].toUpperCase();
      m = l.match(/^a=fmtp:(\d+) (.*)$/);
      if (m) fmtp[m[1]] = { line: i, params: m[2] };
    });

    const mv = lines.findIndex((l) => l.startsWith('m=video'));
    if (mv >= 0) {
      const parts = lines[mv].split(' ');
      const head = parts.slice(0, 3);
      const pts = parts.slice(3);
      const rank = (pt) => {
        const c = rtpmap[pt];
        const f = (fmtp[pt] && fmtp[pt].params) || '';
        if (c === 'VP9') return /profile-id=([1-9])/.test(f) ? 1 : 0;
        if (c === 'AV1') return 2;
        if (c === 'H264') return 3;
        if (c === 'VP8') return 4;
        return 9;
      };
      // RTX/RED/FEC herdam a posição do codec principal (apt=)
      const base = (pt) => { const f = fmtp[pt] && fmtp[pt].params.match(/apt=(\d+)/); return f ? f[1] : pt; };
      const sorted = pts
        .map((pt, i) => ({ pt, i, r: rank(base(pt)) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map((x) => x.pt);
      lines[mv] = [...head, ...sorted].join(' ');
    }

    for (const [pt, codec] of Object.entries(rtpmap)) {
      if (codec !== 'OPUS' || !fmtp[pt]) continue;
      let p = fmtp[pt].params;
      for (const kv of ['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000']) {
        const k = kv.split('=')[0];
        if (new RegExp(`(^|;)${k}=`).test(p)) p = p.replace(new RegExp(`${k}=[^;]*`), kv);
        else p += ';' + kv;
      }
      lines[fmtp[pt].line] = `a=fmtp:${pt} ${p}`;
    }
    return lines.join('\r\n');
  }

  // ---------- Mídia ----------
  function callPeer(id, kind, stream) {
    const key = `${kind}:${id}`;
    const old = S.outCalls.get(key);
    if (old) { try { old.close(); } catch {} }
    const opts = { metadata: { kind } };
    if (kind === 'screen') opts.sdpTransform = tuneSdp;
    const call = S.me.call(id, stream, opts);
    if (!call) return;
    S.outCalls.set(key, call);
    const cleanup = () => { if (S.outCalls.get(key) === call) S.outCalls.delete(key); };
    call.on('close', cleanup);
    call.on('error', cleanup);
    if (kind === 'screen' && call.peerConnection) {
      const pc = call.peerConnection;
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') setQuality(call);
      });
    }
  }

  function onIncomingCall(call) {
    const id = call.peer;
    const kind = (call.metadata && call.metadata.kind) === 'screen' ? 'screen' : 'voice';
    const key = `${kind}:${id}`;
    // Só recebo; cada um envia o próprio áudio/tela numa chamada separada.
    call.answer(undefined, kind === 'screen' ? { sdpTransform: tuneSdp } : undefined);
    call.on('stream', (stream) => {
      const prev = S.inCalls.get(key);
      if (prev && prev.call !== call) { try { prev.call.close(); } catch {} }
      S.inCalls.set(key, { call, stream });
      if (kind === 'voice') attachVoice(id, stream);
      else addTile(id, stream, false);
    });
    const cleanup = () => {
      const cur = S.inCalls.get(key);
      if (cur && cur.call === call) {
        S.inCalls.delete(key);
        if (kind === 'voice') detachVoice(id);
        else removeTile(id);
      }
    };
    call.on('close', cleanup);
    call.on('error', cleanup);
  }

  // Ajusta a qualidade da tela conforme o número de pessoas assistindo,
  // para não estourar o upload de quem está transmitindo.
  function setQuality(call) {
    try {
      const pc = call.peerConnection;
      if (!pc) return;
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (!sender) return;
      const q = quality();
      const h = sender.track.getSettings().height || q.height;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.maxBitrate = perViewerKbps() * 1000;
      enc.scaleResolutionDownBy = h > q.height ? h / q.height : 1;
      enc.maxFramerate = q.fps;
      enc.priority = enc.networkPriority = 'high';
      // Sem isso o navegador derruba a resolução para 540p antes de mexer no fps.
      params.degradationPreference = q.deg;
      sender.setParameters(params).catch((e) => console.warn('setParameters', e));
    } catch {}
  }

  function applyScreenQuality() {
    for (const [key, call] of S.outCalls) if (key.startsWith('screen:')) setQuality(call);
    renderUploadHint();
  }

  function setQualityPreset(name) {
    if (!QUALITY[name]) return;
    S.quality = name;
    try { localStorage.setItem('ptv-quality', name); } catch {}
    const vt = S.screen && S.screen.getVideoTracks()[0];
    if (vt) {
      const q = quality();
      try { vt.contentHint = q.hint; } catch {}
      vt.applyConstraints({ frameRate: { ideal: q.fps, max: q.fps } }).catch(() => {});
    }
    applyScreenQuality();
  }

  // Estimativa do upload de quem transmite (uma cópia do vídeo por pessoa assistindo)
  function renderUploadHint() {
    const el = $('#uploadHint');
    if (!el) return;
    const viewers = S.members.size;
    const mbps = (perViewerKbps() * Math.max(1, viewers)) / 1000 + (viewers * 0.13);
    el.textContent = viewers
      ? `~${Math.ceil(mbps)} Mbps de upload para ${viewers} ${viewers === 1 ? 'pessoa' : 'pessoas'}`
      : 'ninguém assistindo ainda';
    $('#qualitySelect').title = `Qualidade da sua transmissão (${el.textContent})`;
  }

  async function startShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Seu navegador não permite compartilhar tela. Use Chrome, Edge ou Firefox no computador.', 'error');
      return;
    }
    const q = quality();
    const sup = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
    // Áudio de filme/jogo: sem cancelamento de eco nem filtro de ruído (isso é para voz)
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    // Tira do som capturado o áudio que sai do próprio piltonTv (a voz dos amigos).
    // Sem isso, ao compartilhar a tela inteira com som, eles se ouvem de volta (retorno).
    if (sup.restrictOwnAudio) audio.restrictOwnAudio = true;
    if (sup.suppressLocalAudioPlayback) audio.suppressLocalAudioPlayback = false;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: q.fps, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio,
        systemAudio: 'include',      // no Windows deixa mandar o som do PC inteiro
        // Ao compartilhar uma janela, pede só o som dela (sem Discord etc.). Experimental: navegadores que não suportam ignoram.
        windowAudio: 'window',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.', 'error');
      return;
    }
    const vt = stream.getVideoTracks()[0];
    if (vt) {
      try { vt.contentHint = q.hint; } catch {}
      vt.addEventListener('ended', stopShare);
    }
    S.screen = stream;
    addTile(S.myId, stream, true);
    for (const id of S.members.keys()) callPeer(id, 'screen', stream);
    broadcast(myState());
    renderControls();
    renderMembers();
    const surface = vt && vt.getSettings().displaySurface;
    const hasAudio = stream.getAudioTracks().length > 0;
    if (!hasAudio) {
      toast('Compartilhando sem áudio. Para mandar o som, marque "Compartilhar áudio" na janela do navegador.');
    } else if (surface === 'monitor') {
      // O som do PC inteiro inclui outros apps de voz (Discord etc.), e isso o navegador não consegue separar.
      toast(sup.restrictOwnAudio
        ? 'Som do PC ligado. Use a voz do piltonTv: se estiver em call no Discord, seus amigos vão ouvir o Discord de volta.'
        : 'Som do PC ligado: a voz da call pode voltar para os amigos. Para evitar, compartilhe uma guia ou use fone.');
    } else if (surface === 'window') {
      toast('Compartilhando janela com som. Se seus amigos ouvirem o Discord de volta, seu Chrome ainda não separa o som da janela: use uma guia.');
    } else if (surface === 'browser') {
      toast('Dica: coloque o vídeo em tela cheia na aba compartilhada para a melhor qualidade.');
    }
  }

  function stopShare() {
    if (!S.screen) return;
    for (const t of S.screen.getTracks()) t.stop();
    S.screen = null;
    for (const [key, call] of [...S.outCalls]) {
      if (key.startsWith('screen:')) { try { call.close(); } catch {} S.outCalls.delete(key); }
    }
    removeTile(S.myId);
    broadcast(myState());
    renderControls();
    renderMembers();
  }

  function attachVoice(id, stream) {
    let el = document.getElementById('a-' + id);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'a-' + id;
      el.autoplay = true;
      $('#audios').appendChild(el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play().catch(() => {});
    watchLevel(id, stream);
    applyVoiceVolume(id);
  }

  function detachVoice(id) {
    const el = document.getElementById('a-' + id);
    if (el) { el.srcObject = null; el.remove(); }
    const l = S.levels.get(id);
    if (l) {
      try { l.src.disconnect(); } catch {}
      if (l.gain) { try { l.gain.disconnect(); } catch {} }
      S.levels.delete(id);
    }
  }

  // ---------- Volume de cada pessoa ----------
  // Até 100% usa o próprio <audio>. Acima disso (para quem tem microfone baixo)
  // o som passa por um ganho do Web Audio e o <audio> fica mudo para não tocar dobrado.
  function voiceVolume(id) {
    const m = S.members.get(id);
    const v = m && S.volumes[m.name];
    return typeof v === 'number' && v >= 0 && v <= 2 ? v : 1;
  }

  function applyVoiceVolume(id) {
    const el = document.getElementById('a-' + id);
    const l = S.levels.get(id);
    const vol = voiceVolume(id);
    const boost = vol > 1 && l && S.audioCtx;
    if (boost) {
      if (!l.gain) {
        l.gain = S.audioCtx.createGain();
        l.src.connect(l.gain).connect(S.audioCtx.destination);
      }
      l.gain.gain.value = S.deaf ? 0 : vol;
    } else if (l && l.gain) {
      try { l.gain.disconnect(); } catch {}
      l.gain = null;
    }
    if (el) {
      el.volume = boost ? 1 : vol;
      el.muted = S.deaf || boost;
    }
  }

  function setVoiceVolume(id, vol) {
    const m = S.members.get(id);
    if (!m) return;
    if (Math.abs(vol - 1) < 0.001) delete S.volumes[m.name];
    else S.volumes[m.name] = vol;
    try { localStorage.setItem('ptv-volumes', JSON.stringify(S.volumes)); } catch {}
    // Mesmo nome = mesma pessoa (ex.: entrou de dois aparelhos)
    for (const [oid, om] of S.members) if (om.name === m.name) applyVoiceVolume(oid);
  }

  function openVolume(id, anchor) {
    const m = S.members.get(id);
    if (!m) return;
    S.volFor = id;
    const pop = $('#volPop');
    const range = $('#volRange');
    $('#volName').textContent = m.name;
    range.value = Math.round(voiceVolume(id) * 100);
    renderVolumeValue();
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = r.right + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = left === r.right + 8 ? r.top : r.bottom + 6;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    range.focus();
  }

  function closeVolume() {
    S.volFor = null;
    $('#volPop').hidden = true;
  }

  function renderVolumeValue() {
    const v = Number($('#volRange').value);
    $('#volValue').textContent = v + '%';
    $('#volReset').disabled = v === 100;
  }

  function initVolumePopover() {
    const range = $('#volRange');
    range.addEventListener('input', () => {
      renderVolumeValue();
      if (S.volFor) { setVoiceVolume(S.volFor, Number(range.value) / 100); renderMembers(); }
    });
    $('#volReset').addEventListener('click', () => {
      range.value = 100;
      range.dispatchEvent(new Event('input'));
    });
    document.addEventListener('pointerdown', (e) => {
      if ($('#volPop').hidden) return;
      if (e.target.closest('#volPop') || e.target.closest('.member[data-vol]')) return;
      closeVolume();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#volPop').hidden) closeVolume(); });
    window.addEventListener('resize', closeVolume);
    $('.side-section').addEventListener('scroll', closeVolume);
  }

  // Indicador de quem está falando (anel verde no avatar)
  function watchLevel(id, stream) {
    if (!S.audioCtx || !stream.getAudioTracks().length) return;
    const old = S.levels.get(id);
    if (old) {
      try { old.src.disconnect(); } catch {}
      if (old.gain) { try { old.gain.disconnect(); } catch {} }
    }
    const src = S.audioCtx.createMediaStreamSource(stream);
    const analyser = S.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    S.levels.set(id, { src, analyser, buf: new Uint8Array(analyser.fftSize) });
  }

  setInterval(() => {
    if (!S.myId) return;
    if (S.audioCtx && S.audioCtx.state === 'suspended') S.audioCtx.resume().catch(() => {});
    for (const [id, l] of S.levels) {
      l.analyser.getByteTimeDomainData(l.buf);
      let sum = 0;
      for (let i = 0; i < l.buf.length; i++) { const v = (l.buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / l.buf.length);
      const muted = id === S.myId ? S.micMuted : (S.members.get(id) || {}).muted;
      const speaking = rms > 0.035 && !muted;
      const el = document.querySelector(`.member[data-id="${CSS.escape(id)}"]`);
      if (el) el.classList.toggle('speaking', speaking);
      if (id === S.myId) $('#myAvatar').classList.toggle('speaking', speaking);
    }
  }, 120);

  // ---------- Tiles de tela ----------
  function addTile(id, stream, isMine) {
    let tile = document.getElementById('t-' + id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.id = 't-' + id;
      tile.dataset.id = id;
      tile.tabIndex = 0;
      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="tile-label"><span class="live-badge">AO VIVO</span><span class="tile-name"></span></div>
        <div class="tile-tools">
          ${isMine ? '' : `<span title="Volume da transmissão" style="display:flex;color:#fff">${I.vol}</span><input type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">`}
          <button class="icon-btn" data-act="full" title="Tela cheia" aria-label="Tela cheia">${I.full}</button>
        </div>`;
      const video = tile.querySelector('video');
      video.muted = isMine || S.deaf;
      if (isMine) video.dataset.mine = '1';
      const range = tile.querySelector('input[type=range]');
      if (range) {
        range.addEventListener('click', (e) => e.stopPropagation());
        range.addEventListener('input', () => { video.volume = Number(range.value); });
      }
      tile.querySelector('[data-act=full]').addEventListener('click', (e) => {
        e.stopPropagation();
        const fn = tile.requestFullscreen || tile.webkitRequestFullscreen;
        if (document.fullscreenElement) document.exitFullscreen();
        else if (fn) fn.call(tile);
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      });
      tile.addEventListener('click', () => toggleFocus(id));
      tile.addEventListener('dblclick', () => tile.querySelector('[data-act=full]').click());
      $('#tiles').appendChild(tile);
    }
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch(() => {});
    updateTileLabel(id);
    layoutTiles();
  }

  function removeTile(id) {
    const tile = document.getElementById('t-' + id);
    if (!tile) return;
    const v = tile.querySelector('video');
    if (v) v.srcObject = null;
    tile.remove();
    if (S.focus === id) S.focus = null;
    layoutTiles();
  }

  function updateTileLabel(id) {
    const tile = document.getElementById('t-' + id);
    if (!tile) return;
    const name = id === S.myId ? `${S.name} (você)` : ((S.members.get(id) || {}).name || '...');
    tile.querySelector('.tile-name').textContent = name;
  }

  function toggleFocus(id) {
    const count = $('#tiles').querySelectorAll('.tile').length;
    S.focus = S.focus === id || count < 2 ? null : id;
    layoutTiles();
  }

  function layoutTiles() {
    const tiles = $('#tiles');
    const list = [...tiles.querySelectorAll('.tile')];
    $('#emptyStage').hidden = list.length > 0;
    tiles.hidden = list.length === 0;
    if (S.focus && !document.getElementById('t-' + S.focus)) S.focus = null;
    if (list.length < 2) S.focus = null;

    tiles.className = 'tiles count-' + Math.min(list.length, 4) + (S.focus ? ' focused' : '');
    for (const t of list) t.classList.toggle('is-focus', t.dataset.id === S.focus);

    let strip = tiles.querySelector('.strip');
    if (strip) strip.remove();
    if (S.focus) {
      strip = document.createElement('div');
      strip.className = 'strip';
      for (const t of list) {
        if (t.dataset.id === S.focus) continue;
        const item = document.createElement('div');
        item.className = 'strip-item';
        const v = document.createElement('video');
        v.autoplay = true; v.muted = true; v.playsInline = true;
        v.srcObject = t.querySelector('video').srcObject;
        const label = document.createElement('span');
        label.textContent = t.querySelector('.tile-name').textContent;
        item.append(v, label);
        item.addEventListener('click', () => { S.focus = t.dataset.id; layoutTiles(); });
        strip.appendChild(item);
      }
      tiles.appendChild(strip);
    }
  }

  // ---------- Controles ----------
  function toggleMic() {
    if (!S.mic) {
      toast('Nenhum microfone disponível. Libere o microfone no navegador e entre de novo.', 'error');
      return;
    }
    if (S.deaf) setDeaf(false);
    S.micMuted = !S.micMuted;
    for (const t of S.mic.getAudioTracks()) t.enabled = !S.micMuted;
    broadcast(myState());
    renderControls();
    renderMembers();
  }

  function setDeaf(on) {
    S.deaf = on;
    if (on) {
      S.mutedBeforeDeaf = S.micMuted;
      S.micMuted = true;
    } else {
      S.micMuted = S.mutedBeforeDeaf;
    }
    if (S.mic) for (const t of S.mic.getAudioTracks()) t.enabled = !S.micMuted;
    for (const id of S.members.keys()) applyVoiceVolume(id);
    for (const v of $('#tiles').querySelectorAll('.tile video')) if (!v.dataset.mine) v.muted = on;
    broadcast(myState());
    renderControls();
    renderMembers();
  }

  function renderControls() {
    const micOff = S.micMuted || !S.mic;
    const mic = $('#micBtn');
    mic.innerHTML = micOff ? I.micOff : I.mic;
    mic.classList.toggle('off', micOff);
    mic.title = !S.mic ? 'Sem microfone' : (S.micMuted ? 'Desmutar microfone' : 'Mutar microfone');
    mic.setAttribute('aria-label', mic.title);

    const deaf = $('#deafBtn');
    deaf.innerHTML = S.deaf ? I.headOff : I.head;
    deaf.classList.toggle('off', S.deaf);
    deaf.title = S.deaf ? 'Voltar a ouvir' : 'Silenciar áudio';
    deaf.setAttribute('aria-label', deaf.title);

    const share = $('#shareBtn');
    share.innerHTML = S.screen
      ? `${I.stop}<span class="label">Parar</span>`
      : `${I.screen}<span class="label">Compartilhar tela</span>`;
    share.classList.toggle('live', !!S.screen);
    $('#emptyShareBtn').hidden = !!S.screen;

    const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    share.disabled = !canShare;
    share.title = canShare ? '' : 'Compartilhar tela só funciona no computador';
    $('#emptyShareBtn').disabled = !canShare;
    $('#emptyShareBtn').textContent = canShare ? 'Compartilhar minha tela' : 'Compartilhar tela só funciona no computador';
  }

  function renderMembers() {
    const list = $('#memberList');
    list.innerHTML = '';
    const rows = [[S.myId, { name: S.name, muted: S.micMuted || !S.mic, deaf: S.deaf, sharing: !!S.screen }, true]];
    const others = [...S.members].sort((a, b) => a[1].name.localeCompare(b[1].name));
    for (const [id, m] of others) rows.push([id, m, false]);

    for (const [id, m, isMe] of rows) {
      const li = document.createElement('li');
      li.className = 'member' + (isMe ? ' me' : '');
      li.dataset.id = id;
      if (!isMe) {
        li.dataset.vol = '1';
        li.tabIndex = 0;
        li.title = `Volume de ${m.name}`;
        li.classList.toggle('vol-open', S.volFor === id);
        const open = () => (S.volFor === id ? closeVolume() : openVolume(id, li));
        li.addEventListener('click', () => { open(); renderMembers(); });
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); }
        });
      }
      li.appendChild(avatar(m.name));
      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = m.name;
      li.appendChild(name);
      const icons = document.createElement('span');
      icons.className = 'member-icons';
      if (m.sharing) icons.insertAdjacentHTML('beforeend', '<span class="live-badge">AO VIVO</span>');
      if (!isMe) {
        const v = Math.round(voiceVolume(id) * 100);
        if (v === 0) icons.insertAdjacentHTML('beforeend', `<span class="vol-badge off" title="Você zerou o volume">${I.volOff}</span>`);
        else if (v !== 100) icons.insertAdjacentHTML('beforeend', `<span class="vol-badge" title="Volume que você escolheu">${v}%</span>`);
      }
      if (m.deaf) icons.insertAdjacentHTML('beforeend', `<span title="Áudio silenciado">${I.headOff}</span>`);
      else if (m.muted) icons.insertAdjacentHTML('beforeend', `<span title="Mutado">${I.micOff}</span>`);
      li.appendChild(icons);
      list.appendChild(li);
    }
    $('#memberCount').textContent = rows.length;
  }

  // ---------- Chat ----------
  function linkify(text, el) {
    const re = /(https?:\/\/[^\s<]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      el.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = m[1];
      a.textContent = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.append(a);
      last = m.index + m[1].length;
    }
    el.append(text.slice(last));
  }

  function addMessage(name, text, fromId) {
    if (!text.trim()) return;
    const ol = $('#messages');
    const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 60;
    const li = document.createElement('li');
    const cont = S.lastMsgFrom === fromId;
    li.className = 'msg' + (cont ? ' cont' : '');
    if (!cont) {
      li.appendChild(avatar(name));
      const head = document.createElement('div');
      head.className = 'msg-head';
      const n = document.createElement('span');
      n.className = 'msg-name';
      n.textContent = name;
      n.style.color = colorFor(name);
      const t = document.createElement('span');
      t.className = 'msg-time';
      t.textContent = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      head.append(n, t);
      li.appendChild(head);
    }
    const body = document.createElement('div');
    body.className = 'msg-text';
    linkify(text, body);
    li.appendChild(body);
    ol.appendChild(li);
    S.lastMsgFrom = fromId;
    if (atBottom || fromId === S.myId) ol.scrollTop = ol.scrollHeight;

    if (fromId !== S.myId && $('#app').classList.contains('chat-closed')) {
      $('#chatToggle').classList.add('off');
    }
  }

  function systemMsg(text) {
    const li = document.createElement('li');
    li.className = 'msg system';
    li.textContent = text;
    $('#messages').appendChild(li);
    S.lastMsgFrom = null;
    const ol = $('#messages');
    ol.scrollTop = ol.scrollHeight;
  }

  // ---------- Montagem da tela ----------
  function showApp() {
    $('#join').hidden = true;
    $('#app').hidden = false;
    if (window.matchMedia('(max-width: 900px)').matches) $('#app').classList.add('chat-closed');

    $('#roomLabel').textContent = 'sala: ' + S.room;
    $('#roomTitle').textContent = S.room;
    $('#chatInput').placeholder = `Conversar em #${S.room}`;
    $('#myName').textContent = S.name;
    avatar(S.name, $('#myAvatar'));

    $('#leaveBtn').innerHTML = I.leave;
    $('#inviteBtn').innerHTML = `${I.link}<span class="label">Convidar</span>`;
    $('#chatToggle').innerHTML = I.chat;
    $('#chatClose').innerHTML = I.close;
    $('#sidebarToggle').innerHTML = I.people;

    $('#micBtn').addEventListener('click', toggleMic);
    $('#deafBtn').addEventListener('click', () => setDeaf(!S.deaf));
    $('#leaveBtn').addEventListener('click', leave);
    $('#shareBtn').addEventListener('click', () => (S.screen ? stopShare() : startShare()));
    $('#emptyShareBtn').addEventListener('click', startShare);
    $('#chatToggle').addEventListener('click', () => {
      $('#app').classList.toggle('chat-closed');
      $('#chatToggle').classList.remove('off');
      if (!$('#app').classList.contains('chat-closed')) $('#chatInput').focus();
    });
    $('#chatClose').addEventListener('click', () => $('#app').classList.add('chat-closed'));
    $('#sidebarToggle').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#app').classList.toggle('sidebar-open');
    });
    $('.main').addEventListener('click', () => $('#app').classList.remove('sidebar-open'));

    $('#inviteBtn').addEventListener('click', async () => {
      const url = `${location.origin}${location.pathname}?sala=${encodeURIComponent(S.room)}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Link do convite copiado!');
      } catch {
        prompt('Copie o link do convite:', url);
      }
    });

    $('#chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chatInput');
      const text = input.value.trim().slice(0, 500);
      if (!text) return;
      input.value = '';
      addMessage(S.name, text, S.myId);
      broadcast({ type: 'chat', text });
    });

    const sel = $('#qualitySelect');
    for (const [key, q] of Object.entries(QUALITY)) sel.add(new Option(q.label, key, false, key === S.quality));
    sel.value = QUALITY[S.quality] ? S.quality : 'alta';
    sel.addEventListener('change', () => setQualityPreset(sel.value));

    initVolumePopover();
    renderControls();
    renderMembers();
    layoutTiles();
    systemMsg(`Você entrou em #${S.room}`);
    renderUploadHint();
  }

  function cleanup() {
    if (S.leaving) return;
    broadcast({ type: 'bye' }); // avisa na hora, em vez de deixarem a gente "fantasma" na lista
    S.leaving = true;
    if (S.screen) for (const t of S.screen.getTracks()) t.stop();
    if (S.mic) for (const t of S.mic.getTracks()) t.stop();
    try { S.hub && S.hub.destroy(); } catch {}
    try { S.me && S.me.destroy(); } catch {}
  }

  function leave() {
    cleanup();
    location.href = `${location.pathname}?sala=${encodeURIComponent(S.room)}`;
  }

  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);

  // Para depuração no console: __ptv.state()
  window.__ptv = { state: () => S, isHub: () => S.isHub };

  initJoin();
})();
