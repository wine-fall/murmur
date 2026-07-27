// Subprocess Player (spec 01 §3.5, L0 shape): hand a complete local audio
// file to an external player binary; stop() terminates it. Interim only — the
// Web Audio mixing engine replaces this in Phase 3 (spec 03-02).

import { spawn, type ChildProcess } from 'node:child_process'

import type { AudioClip, Player } from './contracts.ts'

export class SubprocessPlayer implements Player {
  private child: ChildProcess | null = null
  private current: Promise<void> | null = null

  private cmd: string

  constructor(cmd = 'afplay') {
    this.cmd = cmd
  }

  play(clip: AudioClip): Promise<void> {
    this.current = new Promise((resolve) => {
      const child = spawn(this.cmd, [clip.source], { stdio: 'ignore' })
      this.child = child
      const done = () => {
        if (this.child === child) this.child = null
        resolve()
      }
      child.on('exit', done)
      // ponytail: a missing/broken player binary degrades to a silent segment;
      // the Phase 3 engine owns real audio-path error surfacing.
      child.on('error', done)
    })
    return this.current
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child === null) return
    // A failed spawn has no pid; kill() would then signal THIS process's own
    // group instead of the (nonexistent) child. Skip the kill and just await
    // settlement via the pending 'error' event.
    if (child.pid !== undefined) child.kill('SIGTERM')
    await this.current // resolves via the exit/error handler; no orphaned player
  }
}
