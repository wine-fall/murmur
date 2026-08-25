// Similar-music lookups over Last.fm's public API (spec 03-01 §2.3). The API
// is an untrusted boundary: every hit is zod-parsed, and anything that does
// not fit is skipped rather than coerced.

import { describe, expect, it } from 'vitest'

import { LastfmSimilar } from '../src/lastfm.ts'

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
  return { calls, client: new LastfmSimilar({ apiKey: 'KEY', fetch: f }) }
}

describe('LastfmSimilar.artists', () => {
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

describe('LastfmSimilar.tracks', () => {
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

describe('a Last.fm that will not answer', () => {
  it('raises the API error message rather than a silent empty list', async () => {
    const { client } = similar({ error: 6, message: 'The artist you supplied could not be found' })
    await expect(client.artists('nobody at all', 5)).rejects.toThrow(/could not be found/)
  })

  it('raises on a non-200 too', async () => {
    const { client } = similar({}, 503)
    await expect(client.artists('Bon Iver', 5)).rejects.toThrow(/503/)
  })
})
