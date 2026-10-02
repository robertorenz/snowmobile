import type { Race, RaceEvent } from './race';
import type { Sled } from './sled';
import { ordinal } from './util';

/** Seconds a line stays on screen, and the least time between two lines. */
const SHOWN = 3.4;
const GAP = 2.6;

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/**
 * A race commentator: watches the race and calls what happens, one short
 * line at a time. The line is shown on the HUD and, if asked, read aloud
 * by the browser's own voice.
 */
export class Commentator {
  /** The line on screen now, or '' for none. */
  line = '';
  private until = 0;
  private quietUntil = 0;
  private clock = 0;
  private leader: Sled | null = null;
  private leaderFor = 0;
  private place = 0;
  private placeFor = 0;
  private air = new Map<Sled, number>();
  private halfway = false;
  private winner = false;
  private started = false;

  constructor(private spoken: () => boolean) {}

  reset() {
    this.line = '';
    this.until = this.quietUntil = this.clock = 0;
    this.leader = null;
    this.leaderFor = this.place = this.placeFor = 0;
    this.air.clear();
    this.halfway = this.winner = this.started = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  /** Says a line, unless one was said a moment ago. Urgent lines always go out. */
  private say(text: string, urgent = false) {
    if (!urgent && this.clock < this.quietUntil) return;
    this.line = text;
    this.until = this.clock + SHOWN;
    this.quietUntil = this.clock + GAP;
    if (this.spoken() && 'speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.15;
      u.pitch = 1.05;
      speechSynthesis.speak(u);
    }
  }

  /** Call once a frame while racing, before the race's events are cleared. */
  update(race: Race, events: RaceEvent[], dt: number) {
    this.clock += dt;
    if (this.line && this.clock > this.until) this.line = '';
    const me = race.player;
    if (!me) return;
    const who = (s: Sled) => (s === me ? 'You' : s.name);
    /** Picks the verb form: "You take" but "Tremblay takes". */
    const v = (s: Sled, third: string, second: string) => (s === me ? second : third);

    for (const e of events) {
      if (e === 'go') {
        this.started = true;
        this.say(pick(['And they are away!', 'Green flag, and the field is off!', 'Off they go!']), true);
      } else if (e === 'final-lap') this.say(pick(['Final lap! Everything to play for.', 'One lap to go.']), true);
      else if (e === 'avalanche') this.say('Avalanche on the course! Stay ahead of it!', true);
      else if (e === 'buried') this.say('Buried by the slide. That will cost time.', true);
      else if (e === 'knockout') this.say('Another rider is out of the knockout.');
      else if (e === 'eliminated') this.say('That is the end of your race.', true);
      else if (e === 'struck') this.say(pick(['Ooh, that is a direct hit!', 'Hit! That knocks the speed off.']));
      else if (e === 'throw') this.say(pick(['Snowball away!', 'A snowball goes down the track.']));
    }
    if (me.trickResult > 0) this.say(me.trickResult > 1 ? `${me.trickResult} flips, landed clean. Incredible!` : pick(['A clean flip! That is free boost.', 'Flip landed. Lovely.']));
    else if (me.trickResult < 0) this.say(pick(['Oh no, a wipeout on the landing.', 'That landing did not go to plan.']));

    if (race.phase !== 'racing' && race.phase !== 'finished') return;
    const field = race.sleds.filter((s) => !s.gone);

    // First across the line.
    const won = field.find((s) => s.finished && s.place === 1);
    if (won && !this.winner) {
      this.winner = true;
      this.say(won === me ? pick(['You win it! What a ride!', 'First across the line. Victory!']) : `${won.name} wins it!`, true);
      return;
    }
    if (me.finished) return;

    // The lead changing hands. It has to hold for a moment, so a side-by-side scrap isn't called twice a second.
    const lead = field.find((s) => s.place === 1) ?? null;
    if (lead !== this.leader) {
      this.leaderFor += dt;
      if (this.leaderFor > 1.2 && lead) {
        const first = this.leader === null;
        this.leader = lead;
        this.leaderFor = 0;
        if (!first && race.time > 6) this.say(pick([`${who(lead)} ${v(lead, 'takes', 'take')} the lead!`, `${who(lead)} ${v(lead, 'goes', 'go')} to the front!`, `New leader: ${lead === me ? 'you' : lead.name}!`]));
      }
    } else this.leaderFor = 0;

    // The player gaining or losing places.
    if (!this.place) this.place = me.place;
    if (me.place !== this.place) {
      this.placeFor += dt;
      if (this.placeFor > 1.5) {
        const up = me.place < this.place;
        this.place = me.place;
        this.placeFor = 0;
        if (race.time > 6 && me.place !== 1) {
          this.say(up ? pick([`Up to ${ordinal(me.place)}!`, `A place gained. ${ordinal(me.place)} now.`]) : pick([`Down to ${ordinal(me.place)}.`, `Passed. You are ${ordinal(me.place)}.`]));
        }
      }
    } else this.placeFor = 0;

    // Big air, called on landing.
    for (const s of field) {
      const was = this.air.get(s) ?? 0;
      if (s.grounded && was > 1.5) this.say(pick([`Huge air from ${s === me ? 'you' : s.name}!`, `${who(s)} ${v(s, 'flies', 'fly')} off that jump!`, `Look at the height on that from ${s === me ? 'you' : s.name}!`]));
      this.air.set(s, s.grounded ? 0 : s.airTime);
    }

    if (!this.halfway && race.playerFraction() > 0.5) {
      this.halfway = true;
      this.say(me.place === 1 ? 'Halfway, and you are leading.' : `Halfway. You are ${ordinal(me.place)}.`);
    }
    if (me.damage > 0.5 && Math.random() < dt * 0.05) this.say('That sled is taking a beating. A repair kit would help.');
  }
}
