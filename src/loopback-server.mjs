import { randomInt } from 'node:crypto';

// A custom Windows ephemeral range may include Fetch-blocked ports such as
// 6000, 6667 and 10080. Pick only usable loopback HTTP ports, without changing
// the machine's range, and retry ordinary local bind conflicts.
export async function listenLoopback(server, choosePort = () => randomInt(20000, 65536)) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = choosePort();
    if (!Number.isInteger(port) || port < 20000 || port > 65535) throw new Error('Invalid automatic loopback port.');
    try {
      await new Promise((ok, fail) => {
        const error = e => { server.off('listening', ready); fail(e); };
        const ready = () => { server.off('error', error); ok(); };
        server.once('error', error); server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
      return;
    } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
  }
  throw new Error('No available local HTTP port.');
}
