"""The mixing audio engine (spec 03-02).

Replaces the spec-01 afplay ``AudioPlayer`` as the sole audio authority: one
output stream, two logical channels (music + voice), sample-level mixing with
a gain-envelope duck. ``mixer`` holds the pure math; ``core`` the engine,
handles, and buffer plumbing (testable with fakes); ``ffmpeg_io`` the real
decoder + sounddevice sink (integration layer).
"""
