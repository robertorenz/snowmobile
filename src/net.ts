import { Peer, DataConnection } from 'peerjs';
import type { Conditions, Difficulty, SurfaceOptions } from './tracks';
import type { SledNet } from './sled';

/**
 * Online rooms. One player hosts; everyone else connects straight to the host
 * (peer-to-peer over WebRTC, with PeerJS's public server used only to find
 * each other). Each computer simulates its own sled and the host simulates
 * the AI riders; positions are exchanged about 20 times a second.
 */

const PREFIX = 'powder-rush-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
export const MAX_PLAYERS = 6;
export const HOST_ID = 'host';

export interface LobbyPlayer {
  id: string;
  name: string;
  /** Id of the snowmobile they've chosen. */
  sled: string;
}

export interface LobbyState {
  players: LobbyPlayer[];
  track: number;
  difficulty: Difficulty;
  racing: boolean;
}

export interface GridEntry {
  kind: 'ai' | 'human';
  /** Player id for humans; empty for AI. */
  id: string;
  name: string;
  color: number;
  /** Id of the snowmobile model; the standard one if absent. */
  sled?: string;
}

export interface StartMsg {
  t: 'start';
  track: number;
  difficulty: Difficulty;
  /** Index is the grid slot, front to back. */
  grid: GridEntry[];
  /** Set when this race is part of an online cup: which cup, and which of its races (from 0). */
  cup?: { cup: number; race: number };
  /** The host's surface settings, so everyone races the same road. */
  surfaces: SurfaceOptions;
  /** The host's season and time of day. */
  cond?: Conditions;
  /** A track from the host's editor, when that is what's being raced. Checked before use. */
  custom?: unknown;
}

type Msg =
  | { t: 'hello'; name: string; sled: string }
  | { t: 'sled'; sled: string }
  | { t: 'lobby'; state: LobbyState; you: string }
  | { t: 'full' }
  | StartMsg
  | { t: 'ready' }
  | { t: 'go' }
  | { t: 'end' }
  | { t: 's'; s: SledNet }
  | { t: 'w'; l: SledNet[] }
  | { t: 'chat'; name: string; text: string }
  /** A snowball landed on the sled in this grid slot. */
  | { t: 'hit'; slot: number };

export function cleanName(name: unknown) {
  const s = String(name ?? '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 14);
  return s || 'Rider';
}

/** A chat line: one line of ordinary text, no control characters, at most 140 long. */
export function cleanChat(text: unknown) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 140);
}

export function cleanCode(code: string) {
  return code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LENGTH);
}

function randomCode() {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
}

export class NetSession {
  lobby: LobbyState = { players: [], track: 0, difficulty: 'easy', racing: false };
  myId = HOST_ID;

  onLobby: () => void = () => {};
  onStart: (msg: StartMsg) => void = () => {};
  onGo: () => void = () => {};
  /** Host ended the race and returned everyone to the lobby. */
  onEnd: () => void = () => {};
  onStates: (list: SledNet[], from: string) => void = () => {};
  /** A chat line for the room. */
  onChat: (name: string, text: string) => void = () => {};
  /** Someone else's snowball hit a sled; whoever drives that slot applies it. */
  onHit: (slot: number) => void = () => {};
  /** A player dropped out (host only). */
  onPlayerLeft: (id: string) => void = () => {};
  /** The room is gone (connection lost or host left). */
  onClosed: (reason: string) => void = () => {};

  private conns = new Map<string, DataConnection>();
  private hostConn: DataConnection | null = null;
  private waitingOn = new Set<string>();
  private goTimer = 0;
  private closed = false;

  private constructor(
    private peer: Peer,
    readonly isHost: boolean,
    readonly code: string,
  ) {}

  // ---------- Creating and joining ----------

  static host(name: string, sled: string, track: number, difficulty: Difficulty): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const code = randomCode();
        const peer = new Peer(PREFIX + code);
        let opened = false;
        peer.on('open', () => {
          opened = true;
          const s = new NetSession(peer, true, code);
          s.lobby = { players: [{ id: HOST_ID, name: cleanName(name), sled }], track, difficulty, racing: false };
          peer.on('connection', (conn) => s.accept(conn));
          resolve(s);
        });
        peer.on('disconnected', () => {
          // Lost the matchmaking server; existing players stay connected.
          if (opened && !peer.destroyed) peer.reconnect();
        });
        peer.on('error', (err) => {
          if (opened) return;
          peer.destroy();
          if (err.type === 'unavailable-id' && ++tries < 6) attempt();
          else reject(new Error('Could not create a room. Check your internet connection and try again.'));
        });
      };
      attempt();
    });
  }

  static join(code: string, name: string, sled: string): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      const peer = new Peer();
      let done = false;
      const fail = (message: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        peer.destroy();
        reject(new Error(message));
      };
      const timer = window.setTimeout(
        () => fail('Could not reach that room. It may be closed, or a firewall is blocking the connection.'),
        15000,
      );
      peer.on('error', (err) => {
        fail(err.type === 'peer-unavailable' ? `Room ${code} was not found.` : 'Connection failed. Try again.');
      });
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        const s = new NetSession(peer, false, code);
        s.hostConn = conn;
        conn.on('open', () => conn.send({ t: 'hello', name: cleanName(name), sled } satisfies Msg));
        conn.on('data', (data) => {
          const msg = data as Msg;
          if (!done && msg.t === 'full') return fail('That room is full.');
          if (!done && msg.t === 'lobby') {
            done = true;
            clearTimeout(timer);
            s.myId = msg.you;
            s.lobby = msg.state;
            resolve(s);
            return;
          }
          if (done) s.fromHost(msg);
        });
        conn.on('close', () => {
          if (!done) fail('The room closed.');
          else s.shutdown('The host closed the room.');
        });
      });
    });
  }

  // ---------- Host side ----------

  private accept(conn: DataConnection) {
    conn.on('data', (data) => {
      const msg = data as Msg;
      const id = conn.peer;
      if (msg.t === 'hello') {
        if (this.lobby.players.length >= MAX_PLAYERS) {
          conn.send({ t: 'full' } satisfies Msg);
          setTimeout(() => conn.close(), 500);
          return;
        }
        if (this.conns.has(id)) return;
        this.conns.set(id, conn);
        this.lobby.players.push({ id, name: cleanName(msg.name), sled: String(msg.sled ?? '').slice(0, 24) });
        this.sendLobby();
        this.onLobby();
      } else if (!this.conns.has(id)) {
        return;
      } else if (msg.t === 'sled') {
        const p = this.lobby.players.find((q) => q.id === id);
        if (p) p.sled = String(msg.sled ?? '').slice(0, 24);
        this.sendLobby();
        this.onLobby();
      } else if (msg.t === 'chat') {
        // The name comes from the lobby, not from the message, so nobody can speak as someone else.
        const who = this.lobby.players.find((q) => q.id === id);
        const line: Msg = { t: 'chat', name: who?.name ?? 'Rider', text: cleanChat(msg.text) };
        if (line.text) {
          this.broadcast(line);
          this.onChat(line.name, line.text);
        }
      } else if (msg.t === 'hit') {
        // Pass it on to everyone else, and take it ourselves in case it's one of ours.
        for (const [other, c] of this.conns) if (other !== id && c.open) c.send(msg);
        this.onHit(msg.slot);
      } else if (msg.t === 's') {
        this.onStates([msg.s], id);
      } else if (msg.t === 'ready') {
        this.markReady(id);
      }
    });
    conn.on('close', () => {
      const id = conn.peer;
      if (!this.conns.delete(id)) return;
      this.lobby.players = this.lobby.players.filter((p) => p.id !== id);
      this.markReady(id);
      this.sendLobby();
      this.onLobby();
      this.onPlayerLeft(id);
    });
  }

  private sendLobby() {
    for (const [id, conn] of this.conns) conn.send({ t: 'lobby', state: this.lobby, you: id } satisfies Msg);
  }

  private broadcast(msg: Msg) {
    for (const conn of this.conns.values()) if (conn.open) conn.send(msg);
  }

  /** Tell the room which snowmobile we've picked. */
  setSled(sled: string) {
    if (this.isHost) {
      this.lobby.players[0].sled = sled;
      this.sendLobby();
    } else if (this.hostConn?.open) this.hostConn.send({ t: 'sled', sled } satisfies Msg);
  }

  /** Host: change the track or difficulty shown to everyone. */
  setSelection(track: number, difficulty: Difficulty) {
    if (!this.isHost) return;
    this.lobby.track = track;
    this.lobby.difficulty = difficulty;
    this.sendLobby();
  }

  /** Host: tell everyone to load the race. The start signal follows once all are ready. */
  hostStart(msg: StartMsg) {
    this.lobby.racing = true;
    this.sendLobby();
    this.waitingOn = new Set(msg.grid.filter((g) => g.kind === 'human').map((g) => g.id));
    this.broadcast(msg);
    clearTimeout(this.goTimer);
    // Don't let one slow computer hold up the grid forever.
    this.goTimer = window.setTimeout(() => this.fireGo(), 10000);
  }

  /** Host: the given player has the track loaded. */
  markReady(id: string) {
    if (!this.isHost || this.waitingOn.size === 0) return;
    this.waitingOn.delete(id);
    if (this.waitingOn.size === 0) this.fireGo();
  }

  private fireGo() {
    clearTimeout(this.goTimer);
    this.waitingOn.clear();
    this.broadcast({ t: 'go' });
    this.onGo();
  }

  /** Host: send every sled's state to all players. */
  sendWorld(list: SledNet[]) {
    this.broadcast({ t: 'w', l: list });
  }

  /** Host: race over, everyone back to the lobby. */
  hostEnd() {
    clearTimeout(this.goTimer);
    this.waitingOn.clear();
    this.lobby.racing = false;
    this.broadcast({ t: 'end' });
    this.sendLobby();
  }

  // ---------- Client side ----------

  private fromHost(msg: Msg) {
    if (msg.t === 'lobby') {
      this.lobby = msg.state;
      this.onLobby();
    } else if (msg.t === 'start') this.onStart(msg);
    else if (msg.t === 'go') this.onGo();
    else if (msg.t === 'end') this.onEnd();
    else if (msg.t === 'w') this.onStates(msg.l, HOST_ID);
    else if (msg.t === 'hit') this.onHit(msg.slot);
    else if (msg.t === 'chat') this.onChat(cleanName(msg.name), cleanChat(msg.text));
  }

  /** Client: send our own sled to the host. */
  sendState(s: SledNet) {
    if (this.hostConn?.open) this.hostConn.send({ t: 's', s } satisfies Msg);
  }

  /** Say something to the room. */
  sendChat(text: string) {
    const clean = cleanChat(text);
    if (!clean) return;
    if (this.isHost) {
      const name = this.lobby.players[0].name;
      this.broadcast({ t: 'chat', name, text: clean });
      this.onChat(name, clean);
    } else if (this.hostConn?.open) this.hostConn.send({ t: 'chat', name: '', text: clean } satisfies Msg);
  }

  /** Report that our snowball hit the sled in a slot somebody else drives. */
  sendHit(slot: number) {
    const msg: Msg = { t: 'hit', slot };
    if (this.isHost) this.broadcast(msg);
    else if (this.hostConn?.open) this.hostConn.send(msg);
  }

  /** Client: our track is loaded. */
  sendReady() {
    if (this.isHost) this.markReady(HOST_ID);
    else if (this.hostConn?.open) this.hostConn.send({ t: 'ready' } satisfies Msg);
  }

  // ---------- Leaving ----------

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.goTimer);
    this.peer.destroy();
    this.onClosed(reason);
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.goTimer);
    this.peer.destroy();
  }
}
