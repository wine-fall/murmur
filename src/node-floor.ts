// The Node floor the published package runs on (package.json engines), checked
// at the door. npm only warns on an engines mismatch, so an older Node installs
// murmur fine and then dies mid-broadcast the first time recall opens FTS5 —
// which node:sqlite ships from 22.16 on the 22 line and from 24.0, not in 23.

export function supportsNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 16)
}

if (!supportsNode(process.version)) {
  console.error(`murmur needs Node 22.16+ or 24+, and this is Node ${process.version}.`)
  process.exit(1)
}
