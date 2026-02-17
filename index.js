const cluster = require('cluster');
const os = require('os');
const fs = require('fs').promises;
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const readline = require('readline');

const WORKING_FILE         = 'working_socks4.txt';
const INPUT_URLS_FILE      = 'urls.txt';

const MAX_ACTIVE_PER_WORKER = 60; 
const CHECK_TIMEOUT        = 5000;    
const DOWNLOAD_TIMEOUT     = 10000;
const TEST_URL             = 'http://138.201.139.144'; // dont change

function ProxyNormalizator(p) {
  p = p.trim();
  if (p.startsWith('socks4://') || p.startsWith('socks5://') || p.startsWith('http://')) {
    p = p.replace(/^(socks[45]?|http):\/\//i, '');
  }
  return p;
}

function ValidProxy(line) {
  line = line.trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return false;
  if (/https?:\/\//i.test(line) || /socks5/i.test(line)) return false;
  return line.includes(':') && line.split(':').length >= 2;
}

if (cluster.isMaster) {
  console.log(`Master ${process.pid} starting SOCKS4 checker...`);

  let TotalChecked = 0;
  let TotalGood = 0;
  let LastChecke = 0;
  let lastTime = Date.now();
  const CheckCache = [];

  setInterval(() => {
    const now = Date.now();
    CheckCache.push((TotalChecked - LastChecke / (now - lastTime) / 1000 || 1).toFixed(1));
    if (CheckCache.length > 10) CheckCache.shift();

    const avg = (CheckCache.reduce((a, b) => a + Number(b), 0) / CheckCache.length).toFixed(1);

    console.log(
      `[STATS] Checked: ${TotalChecked.toLocaleString()} | ` +
      `Working: ${TotalGood.toLocaleString()} | ` +
      `Speed: ~${avg} checks/sec`
    );

    LastChecke = TotalChecked;
    lastTime = now;
  }, 1000);

  (async () => {
    const known = new Set();
    try {
      const content = await fs.readFile(WORKING_FILE, 'utf-8');
      content.split('\n')
        .map(ProxyNormalizator)
        .filter(Boolean)
        .forEach(p => known.add(p));
      TotalGood = known.size;
      console.log(`Loaded & deduplicated ${TotalGood} SOCKS4 proxies`);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(e);
      console.log('No working_socks4.txt – starting fresh');
    }

    let sources;
    try {
      const data = await fs.readFile(INPUT_URLS_FILE, 'utf-8');
      sources = data.split('\n')
        .map(u => u.trim())
        .filter(u => u.startsWith('http'));
    } catch (e) {
      console.error(`Cannot read ${INPUT_URLS_FILE}: ${e.message}`);
      process.exit(1);
    }

    if (!sources.length) {
      console.log('No URLs found');
      process.exit(0);
    }

    console.log(`Found ${sources.length} sources – forking workers...\n`);

    const MachineWorkers = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
    const workers = [];

    for (let i = 0; i < MachineWorkers; i++) {
      const worker = cluster.fork();
      workers.push(worker);

      worker.on('message', (msg) => {
        if (msg.type === 'GOOD_PROXY') {
          const norm = ProxyNormalizator(msg.proxy);
          if (!known.has(norm)) {
            known.add(norm);
            TotalGood++;
            fs.appendFile(WORKING_FILE, norm + '\n').catch(() => {});
            console.log(`  GOOD (w${worker.process.pid}) → ${norm}`);
          }
        } else if (msg.type === 'CHECKED_ONE') {
          TotalChecked++;
        }
      });
    }

    let idx = 0;
    for (const url of sources) {
      workers[idx % workers.length].send({ type: 'CHECK_URL', url });
      idx++;
    }

    cluster.on('exit', (worker, code) => {
      console.log(`Worker ${worker.process.pid} died (code ${code}) – restarting`);
      const nw = cluster.fork();
      workers[workers.indexOf(worker)] = nw;
    });
  })();

} else {
  console.log(`Worker ${process.pid} online (SOCKS4 mode)`);

  let active = 0;

  async function CheckProxy(proxy) {
    active++;
    try {
      const agent = new SocksProxyAgent(proxy.startsWith('socks4://') ? proxy : `socks4://${proxy}`, {
        timeout: CHECK_TIMEOUT,
        keepAlive: false,
      });

      const res = await axios.get(TEST_URL, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: CHECK_TIMEOUT,
        responseType: 'text',
        validateStatus: s => s === 200,
      });

      if ((res.data || '').trim().includes('hello')) {
        process.send({ type: 'GOOD_PROXY', proxy });
      }
    } catch {
    } finally {
      active--;
      process.send({ type: 'CHECKED_ONE' });
    }
  }

  async function ProcessURL(url) {
    console.log(`Worker ${process.pid} → ${url}`);

    let count = 0;

    try {
      const resp = await axios.get(url, {
        timeout: DOWNLOAD_TIMEOUT,
        responseType: 'stream',
      });

      if (resp.status !== 200) {
        console.log(`  HTTP ${resp.status}`);
        return;
      }

      const rl = readline.createInterface({ input: resp.data });

      for await (const line of rl) {
        const proxy = line.trim();
        if (!ValidProxy(proxy)) continue;

        count++;

        while (active >= MAX_ACTIVE_PER_WORKER) {
          await new Promise(r => setTimeout(r, 200));
        }

        CheckProxy(proxy);

        process.stdout.write(`\rWorker ${process.pid} – lines: ${count}  •  active: ${active}  `);
      }

      console.log(`\nWorker ${process.pid} finished ${url} (${count} lines)`);
    } catch (e) {
      console.log(`Worker ${process.pid} error on ${url}: ${e.message}`);
    }
  }

  process.on('message', (msg) => {
    if (msg.type === 'CHECK_URL') {
      ProcessURL(msg.url);
    }
  });
}
