// The listening-data adapter (spec 03-01 §2.3): similar artists, similar
// tracks, and an artist's most-played, over the public audioscrobbler protocol.
// A remote catalogue is an untrusted boundary: every hit is zod-parsed, and
// anything that does not fit is skipped rather than coerced.

import { describe, expect, it } from 'vitest'

import { HostedListening } from '../src/listening-data.ts'

function fake(payload: unknown, status = 200): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = []
  const f = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return new Response(JSON.stringify(payload), { status })
  }) as typeof fetch
  return { calls, fetch: f }
}

const similar = (payload: unknown, status = 200) => {
  const { calls, fetch: f } = fake(payload, status)
  return { calls, client: new HostedListening({ apiKey: 'KEY', fetch: f }) }
}

describe('HostedListening.artists', () => {
  it('asks artist.getsimilar with the key and limit, and returns the names', async () => {
    const { calls, client } = similar({
      similarartists: {
        artist: [
          { name: 'Fleet Foxes', match: '1' },
          { name: 'Big Thief', match: '0.7' },
        ],
      },
    })

    expect(await client.artists('Bon Iver', 2)).toEqual(['Fleet Foxes', 'Big Thief'])
    const url = new URL(calls[0]!)
    expect(url.origin + url.pathname).toBe('https://ws.audioscrobbler.com/2.0/')
    expect(url.searchParams.get('method')).toBe('artist.getsimilar')
    expect(url.searchParams.get('artist')).toBe('Bon Iver')
    expect(url.searchParams.get('api_key')).toBe('KEY')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('limit')).toBe('2')
  })

  it('skips hits that do not fit and survives an empty result', async () => {
    const { client } = similar({ similarartists: { artist: [{ name: '' }, { nope: 1 }, { name: 'Grouper' }] } })
    expect(await client.artists('Bon Iver', 5)).toEqual(['Grouper'])
    const { client: empty } = similar({ similarartists: {} })
    expect(await empty.artists('Bon Iver', 5)).toEqual([])
  })
})

describe('HostedListening.tracks', () => {
  it('asks track.getsimilar and returns title + artist pairs', async () => {
    const { calls, client } = similar({
      similartracks: {
        track: [
          { name: 'Skinny Love', artist: { name: 'Bon Iver' } },
          { name: 'Blue Ridge Mountains', artist: { name: 'Fleet Foxes' } },
        ],
      },
    })

    expect(await client.tracks('Bon Iver', 'Holocene', 2)).toEqual([
      { title: 'Skinny Love', artist: 'Bon Iver' },
      { title: 'Blue Ridge Mountains', artist: 'Fleet Foxes' },
    ])
    const url = new URL(calls[0]!)
    expect(url.searchParams.get('method')).toBe('track.getsimilar')
    expect(url.searchParams.get('track')).toBe('Holocene')
    expect(url.searchParams.get('artist')).toBe('Bon Iver')
  })
})

// The trap the artist-level lookup leaves open: a fresh artist whose ONE
// famous song is what the model would have named anyway.
describe('HostedListening.topTracks', () => {
  it('asks artist.gettoptracks and returns the titles people actually play', async () => {
    const { calls, client } = similar({
      toptracks: {
        track: [
          { name: 'Blue Ridge Mountains', playcount: '900000' },
          { name: 'Mykonos', playcount: '800000' },
        ],
      },
    })

    expect(await client.topTracks('Fleet Foxes', 2)).toEqual(['Blue Ridge Mountains', 'Mykonos'])
    const url = new URL(calls[0]!)
    expect(url.searchParams.get('method')).toBe('artist.gettoptracks')
    expect(url.searchParams.get('artist')).toBe('Fleet Foxes')
    expect(url.searchParams.get('limit')).toBe('2')
  })

  it('skips malformed hits and survives an empty result', async () => {
    const { client } = similar({ toptracks: { track: [{ name: '' }, { name: 'Tiger Mountain Peasant Song' }] } })
    expect(await client.topTracks('Fleet Foxes', 5)).toEqual(['Tiger Mountain Peasant Song'])
    const { client: empty } = similar({ toptracks: {} })
    expect(await empty.topTracks('Fleet Foxes', 5)).toEqual([])
  })
})

describe('a catalogue that will not answer', () => {
  it('raises the API error message rather than a silent empty list', async () => {
    const { client } = similar({ error: 6, message: 'The artist you supplied could not be found' })
    await expect(client.artists('nobody at all', 5)).rejects.toThrow(/could not be found/)
  })

  it('raises on a non-200 too', async () => {
    const { client } = similar({}, 503)
    await expect(client.artists('Bon Iver', 5)).rejects.toThrow(/503/)
  })

  // The failure the listener has to act on is "this endpoint said no", and the
  // method is what says which lookup: neither needs a brand in the sentence.
  it('names the lookup, not a vendor, when it fails', async () => {
    const { client } = similar({}, 503)
    await expect(client.artists('Bon Iver', 5)).rejects.toThrow(/artist\.getsimilar/)
    await expect(client.artists('Bon Iver', 5)).rejects.not.toThrow(/last\.fm/i)
  })
})

// The endpoint is a knob, not a constant, so the class is named for what it is
// rather than for whoever answers: any host speaking the same protocol works.
describe('a different host', () => {
  it('sends the lookups wherever it is pointed', async () => {
    const { calls, fetch: f } = fake({ similarartists: { artist: [{ name: 'Grouper' }] } })
    const client = new HostedListening({ apiKey: 'KEY', endpoint: 'https://libre.fm/2.0/', fetch: f })
    expect(await client.artists('Bon Iver', 3)).toEqual(['Grouper'])
    expect(new URL(calls[0]!).origin).toBe('https://libre.fm')
  })
})
