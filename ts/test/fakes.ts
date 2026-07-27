// Fakes for the seams (DESIGN §11.1): the unit layer drives the Director and
// friends with these — no network, LLM, audio, or real stdin.

import { setTimeout as sleep } from 'node:timers/promises'

import type { AudioClip, Brain, ContextPack, Player, TalkBeat } from '../src/contracts.ts'
import type { Host } from '../src/host.ts'
import { LineQueue } from '../src/host.ts'

export class FakeBrain implements Brain {
  // Each nextTalks call shifts one batch; empty list -> throws (failure mode).
  batches: string[][] = []
  nextTalksCalls = 0
  respondCalls: string[] = []
  respondContexts: ContextPack[] = []
  respondDelayMs = 0
  failRespond = false

  async nextTalks(_ctx: ContextPack, _count: number): Promise<TalkBeat[]> {
    this.nextTalksCalls++
    const batch = this.batches.shift()
    if (batch === undefined) throw new Error('no more batches')
    return batch.map((text) => ({ text }))
  }

  async respond(userText: string, ctx: ContextPack): Promise<string> {
    if (this.respondDelayMs > 0) await sleep(this.respondDelayMs)
    this.respondCalls.push(userText)
    this.respondContexts.push(ctx)
    if (this.failRespond) throw new Error('brain down')
    return `re:${userText}`
  }
}

export class FakeVoice {
  synthesized: string[] = []
  failTimes = 0

  async start(): Promise<void> {}

  async synthesize(text: string): Promise<AudioClip> {
    if (this.failTimes > 0) {
      this.failTimes--
      throw new Error('synth down')
    }
    this.synthesized.push(text)
    return { source: `/fake/${this.synthesized.length}.wav`, kind: 'talk' }
  }

  async close(): Promise<void> {}
}

export class FakePlayer implements Player {
  played: AudioClip[] = []
  stops = 0
  // auto: play resolves immediately. Manual: resolves on finish()/stop().
  auto = true
  private release: (() => void) | null = null

  play(clip: AudioClip): Promise<void> {
    this.played.push(clip)
    if (this.auto) return Promise.resolve()
    return new Promise((resolve) => (this.release = resolve))
  }

  async stop(): Promise<void> {
    this.stops++
    this.finish()
  }

  finish(): void {
    this.release?.()
    this.release = null
  }

  get playing(): boolean {
    return this.release !== null
  }
}

export class FakeHost implements Host {
  private queue = new LineQueue()
  radio: string[] = []
  user: string[] = []
  infos: string[] = []

  start(): void {}

  type(line: string): void {
    this.queue.push(line)
  }

  peekLine(): Promise<string> {
    return this.queue.peek()
  }

  takeLine(): string | undefined {
    return this.queue.take()
  }

  onRadioSegment(text: string): void {
    this.radio.push(text)
  }

  onUserLine(text: string): void {
    this.user.push(text)
  }

  info(message: string): void {
    this.infos.push(message)
  }
}

// Poll until `cond` is true (or fail after ~1s) — keeps timing-based director
// tests robust without fixed sleeps.
export async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}
