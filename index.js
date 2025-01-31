const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const readline = require("readline");
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs').promises;
const kleur = require('kleur');

// Configuration
const config = {
  tokens: [],
  proxies: [],
  proxyGroups: {},
  currentProxyIndices: {},
  baseUrl: "https://app.despeed.net",
  checkInterval: 60000,
  proxy: {
    enabled: false,
    type: "http",
    timeout: 10000,
    maxRetries: 3,
    testUrl: "https://api.ipify.org?format=json"
  }
};

// Modern console output helper
const logger = {
  info: (msg) => console.log(kleur.blue('ℹ'), kleur.white(msg)),
  success: (msg) => console.log(kleur.green('✔'), kleur.white(msg)),
  warning: (msg) => console.log(kleur.yellow('⚠'), kleur.white(msg)),
  error: (msg) => console.log(kleur.red('✖'), kleur.white(msg)),
  speed: (msg) => console.log(kleur.cyan('↯'), kleur.white(msg)),
  time: (msg) => console.log(kleur.magenta('⏰'), kleur.white(msg)),
  location: (msg) => console.log(kleur.yellow('📍'), kleur.white(msg)),
  network: (msg) => console.log(kleur.blue('🌐'), kleur.white(msg))
};

// Read tokens from file
async function loadTokensFromFile() {
  try {
    const content = await fs.readFile('token.txt', 'utf8');
    const tokens = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    if (tokens.length === 0) {
      throw new Error('No valid tokens found in token.txt');
    }
    
    config.tokens = tokens;
    logger.success(`Loaded ${tokens.length} tokens from token.txt`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error('token.txt file not found');
    } else {
      logger.error(`Error reading token file: ${error.message}`);
    }
    return false;
  }
}

// Read proxy from file
async function loadProxyFromFile() {
  try {
    const proxyContent = await fs.readFile('proxy.txt', 'utf8');
    const proxyUrl = proxyContent.trim();
    
    if (!proxyUrl) {
      return null;
    }

    if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
      config.proxy.type = 'http';
      config.proxy.url = proxyUrl;
    } else if (proxyUrl.startsWith('socks4://')) {
      config.proxy.type = 'socks4';
      config.proxy.url = proxyUrl;
    } else if (proxyUrl.startsWith('socks5://')) {
      config.proxy.type = 'socks5';
      config.proxy.url = proxyUrl;
    } else {
      config.proxy.type = 'http';
      config.proxy.url = `http://${proxyUrl}`;
    }

    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error(`Error reading proxy file: ${error.message}`);
    }
    return null;
  }
}

// 프록시 그룹 설정 함수 추가
async function setupProxyGroups(tokens, proxies) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query) => new Promise((resolve) => rl.question(query, resolve));

  logger.info(`토큰 수: ${tokens.length}, 프록시 수: ${proxies.length}`);
  
  const distribution = await question(
    kleur.cyan('프록시 분배 방식을 선택하세요:\n') +
    kleur.white('1. 균등 분배 (프록시를 토큰별로 동일하게 나눔)\n') +
    kleur.white('2. 수동 설정 (토큰당 프록시 수를 직접 지정)\n') +
    kleur.cyan('선택 (1 또는 2): ')
  );

  if (distribution === '1') {
    const proxiesPerToken = Math.floor(proxies.length / tokens.length);
    tokens.forEach((token, index) => {
      const start = index * proxiesPerToken;
      const end = index === tokens.length - 1 ? proxies.length : start + proxiesPerToken;
      config.proxyGroups[token] = proxies.slice(start, end);
      config.currentProxyIndices[token] = 0;
    });
  } else {
    for (let i = 0; i < tokens.length; i++) {
      const count = parseInt(await question(
        kleur.cyan(`토큰 ${i + 1}번에 할당할 프록시 수를 입력하세요 (최대 ${proxies.length}개): `)
      ));

      if (isNaN(count) || count < 1 || count > proxies.length) {
        logger.error('잘못된 숫자입니다. 다시 시도해주세요.');
        i--;
        continue;
      }

      const availableProxies = proxies.filter(p => 
        !Object.values(config.proxyGroups).flat().includes(p)
      );

      if (availableProxies.length < count) {
        logger.error('사용 가능한 프록시가 부족합니다.');
        i--;
        continue;
      }

      config.proxyGroups[tokens[i]] = availableProxies.slice(0, count);
      config.currentProxyIndices[tokens[i]] = 0;
    }
  }

  rl.close();
  
  // 설정된 그룹 정보 출력
  logger.success('프록시 그룹 설정 완료:');
  tokens.forEach((token, index) => {
    logger.info(`토큰 ${index + 1}: ${config.proxyGroups[token].length}개의 프록시 할당됨`);
  });
}

// 토큰별 다음 프록시 가져오기
function getNextProxyForToken(token) {
  const proxyGroup = config.proxyGroups[token];
  if (!proxyGroup || proxyGroup.length === 0) return null;
  
  const currentIndex = config.currentProxyIndices[token];
  const proxy = proxyGroup[currentIndex];
  
  // 다음 인덱스로 순환
  config.currentProxyIndices[token] = (currentIndex + 1) % proxyGroup.length;
  
  return proxy;
}

// 프록시 에이전트 생성 함수 수정
async function createProxyAgent(token) {
  const proxyUrl = getNextProxyForToken(token);
  if (!proxyUrl) return undefined;

  try {
    if (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://')) {
      return new HttpsProxyAgent({
        proxy: proxyUrl,
        timeout: config.proxy.timeout,
        keepAlive: true,
        maxFreeSockets: 256,
        maxSockets: 256
      });
    } else {
      const type = proxyUrl.startsWith('socks4://') ? 4 : 5;
      return new SocksProxyAgent({
        proxy: proxyUrl,
        timeout: config.proxy.timeout,
        keepAlive: true,
        type: type
      });
    }
  } catch (error) {
    logger.error(`프록시 에이전트 생성 실패: ${error.message}`);
    return undefined;
  }
}

// Check proxy availability
async function isProxyAlive(proxyAgent) {
  try {
    const response = await fetch(config.proxy.testUrl, {
      agent: proxyAgent,
      timeout: config.proxy.timeout
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Get working proxy agent with retries
async function getProxyAgent(token, retries = config.proxy.maxRetries) {
  if (!config.proxy.enabled) return undefined;

  for (let i = 0; i < retries; i++) {
    try {
      const agent = await createProxyAgent(token);
      if (!agent) {
        return undefined;
      }

      if (await isProxyAlive(agent)) {
        logger.success(`프록시 연결 성공`);
        return agent;
      }

      logger.warning(`프록시 확인 실패, 시도 ${i + 1}/${retries}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));

    } catch (error) {
      logger.error(`프록시 오류 (${i + 1}/${retries}): ${error.message}`);
      if (i === retries - 1) {
        throw new Error('최대 프록시 재시도 횟수에 도달했습니다');
      }
    }
  }

  return undefined;
}

// Generate random location
function generateRandomLocation() {
  const bounds = {
    minLat: 18.0,
    maxLat: 53.55,
    minLng: 73.66,
    maxLng: 135.05
  };
  
  const latitude = bounds.minLat + Math.random() * (bounds.maxLat - bounds.minLat);
  const longitude = bounds.minLng + Math.random() * (bounds.maxLng - bounds.minLng);
  
  return {
    latitude: Math.round(latitude * 1000000) / 1000000,
    longitude: Math.round(longitude * 1000000) / 1000000
  };
}

// Initialize configuration
async function initConfig() {
  logger.info('설정 초기화 중...');

  const tokensLoaded = await loadTokensFromFile();
  if (!tokensLoaded) {
    throw new Error('token.txt 파일에서 토큰을 로드하는데 실패했습니다.');
  }

  const proxyFileExists = await loadProxyFromFile();
  if (proxyFileExists) {
    logger.success('proxy.txt에서 프록시 설정을 로드했습니다.');
    config.proxy.enabled = true;
    await setupProxyGroups(config.tokens, config.proxies);
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const question = (query) => new Promise((resolve) => rl.question(query, resolve));

    const useProxy = (await question(kleur.cyan('Use proxy? (y/n): '))).toLowerCase() === 'y';
    if (useProxy) {
      config.proxy.enabled = true;
      const proxyUrl = await question(kleur.cyan('Enter proxy URL (e.g., http://user:pass@ip:port or socks5://ip:port): '));
      config.proxy.url = proxyUrl;
      
      if (proxyUrl.startsWith('socks4://')) {
        config.proxy.type = 'socks4';
      } else if (proxyUrl.startsWith('socks5://')) {
        config.proxy.type = 'socks5';
      } else {
        config.proxy.type = 'http';
      }
    }

    const interval = await question(kleur.cyan('Enter check interval (minutes, default 1): '));
    config.checkInterval = (parseInt(interval) || 1) * 60000;

    rl.close();
  }

  logger.success('Configuration completed!');
  logger.info('Current settings:');
  const safeConfig = {...config, tokens: `${config.tokens.length} tokens loaded`};
  console.log(kleur.gray(JSON.stringify(safeConfig, null, 2)));
}

// Get common headers
function getCommonHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'sec-ch-ua': '"Microsoft Edge";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Origin': 'https://app.despeed.net',
    'Referer': 'https://app.despeed.net/dashboard'
  };
}

// Validate token
async function validateToken(token) {
  if (!token) {
    throw new Error('Token not found');
  }
  
  try {
    const tokenData = JSON.parse(atob(token.split('.')[1]));
    if ((tokenData.exp - 90) * 1000 < Date.now()) {
      throw new Error('Token expired');
    }

    const proxyAgent = await getProxyAgent(token);
    const profileResponse = await fetch(`${config.baseUrl}/v1/api/auth/profile`, {
      headers: getCommonHeaders(token),
      agent: proxyAgent,
      timeout: 30000
    });

    if (!profileResponse.ok) {
      throw new Error('Token invalid');
    }

    return true;
  } catch (error) {
    logger.error(`Token validation failed: ${error.message}`);
    return false;
  }
}

// Perform speed test
async function performSpeedTest() {
  try {
    logger.network('Starting network speed measurement...');
    
    const metadata = {
      client_name: 'speed-measurementlab-net-1',
      client_session_id: crypto.randomUUID()
    };

    const proxyAgent = await getProxyAgent();
    
    const locateUrl = new URL('https://locate.measurementlab.net/v2/nearest/ndt/ndt7');
    locateUrl.search = new URLSearchParams(metadata).toString();
    
    logger.info('Locating speed test server...');
    const locateResponse = await fetch(locateUrl, {
      agent: proxyAgent,
      timeout: 30000
    });

    if (!locateResponse.ok) {
      throw new Error(`Failed to get speed test server: ${locateResponse.status}`);
    }

    const serverData = await locateResponse.json();
    if (!serverData.results || !serverData.results[0]) {
      throw new Error('No available speed test server');
    }

    const server = serverData.results[0];
    logger.success(`Selected server: ${server.machine}`);

    const downloadUrl = server.urls['wss:///ndt/v7/download'];
    const uploadUrl = server.urls['wss:///ndt/v7/upload'];

    // Download test
    logger.network('Starting download test...');
    let downloadSpeed = 0;
    await new Promise((resolve) => {
      const wsOptions = config.proxy.enabled ? {
        agent: proxyAgent
      } : undefined;
      
      const ws = new WebSocket(downloadUrl, 'net.measurementlab.ndt.v7', wsOptions);
      let startTime = Date.now();
      let totalBytes = 0;
      let lastMeasurement = null;

      ws.on('open', () => {
        startTime = Date.now();
        totalBytes = 0;
      });

      ws.on('message', (data) => {
        if (typeof data === 'string') {
          lastMeasurement = JSON.parse(data);
          return;
        }
        totalBytes += data.length;
        const now = Date.now();
        const duration = (now - startTime) / 1000;
        if (duration >= 10) {
          downloadSpeed = (totalBytes * 8) / (duration * 1000000);
          ws.close();
        }
      });

      ws.on('close', () => {
        logger.speed(`Download: ${downloadSpeed.toFixed(2)} Mbps`);
        resolve();
      });

      ws.on('error', (error) => {
        logger.error(`Download test error: ${error.message}`);
        resolve();
      });
    });

    // Upload test with fixes
    logger.network('Starting upload test...');
    let uploadSpeed = 0;
    await new Promise((resolve) => {
      const wsOptions = config.proxy.enabled ? {
        agent: proxyAgent
      } : undefined;
      
      const ws = new WebSocket(uploadUrl, 'net.measurementlab.ndt.v7', wsOptions);
      let startTime = null;
      let totalBytes = 0;
      let lastMeasurement = null;
      let uploadInterval = null;
      
      // Create smaller chunks for upload
      const chunkSize = 16384; // 16KB chunks
      const uploadData = Buffer.alloc(chunkSize);
      crypto.randomFillSync(uploadData);

      ws.on('open', () => {
        startTime = Date.now();
        totalBytes = 0;

        uploadInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const now = Date.now();
            const duration = (now - startTime) / 1000;
            
            if (duration >= 10) {
              uploadSpeed = (totalBytes * 8) / (duration * 1000000);
              clearInterval(uploadInterval);
              ws.close();
              return;
            }

            // Send data only if WebSocket buffer is not too full
            if (ws.bufferedAmount < 1024 * 1024) {
              ws.send(uploadData);
              totalBytes += uploadData.length;
            }
          }
        }, 1); // Send data every millisecond
      });

      ws.on('message', (data) => {
        if (typeof data === 'string') {
          try {
            lastMeasurement = JSON.parse(data);
            if (lastMeasurement.TCPInfo) {
              const tcpInfo = lastMeasurement.TCPInfo;
              const elapsed = tcpInfo.ElapsedTime || 1;  // Prevent division by zero
              if (elapsed > 0) {
                const tmpSpeed = (tcpInfo.BytesReceived / elapsed) * 8;
                if (tmpSpeed > uploadSpeed) {
                  uploadSpeed = tmpSpeed;
                }
              }
            }
          } catch (e) {
            logger.error(`Error parsing server message: ${e.message}`);
          }
        }
      });

      ws.on('close', () => {
        if (uploadInterval) {
          clearInterval(uploadInterval);
        }
        
        // Calculate final speed if not already set
        if (uploadSpeed === 0 && startTime && totalBytes > 0) {
          const duration = (Date.now() - startTime) / 1000;
          uploadSpeed = (totalBytes * 8) / (duration * 1000000);
        }
        
        logger.speed(`Upload: ${uploadSpeed.toFixed(2)} Mbps`);
        resolve();
      });

      ws.on('error', (error) => {
        if (uploadInterval) {
          clearInterval(uploadInterval);
        }
        logger.error(`Upload test error: ${error.message}`);
        resolve();
      });

      // Set a timeout to ensure the test doesn't run forever
      setTimeout(() => {
        if (uploadInterval) {
          clearInterval(uploadInterval);
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }, 15000); // 15 second timeout
    });

    return { downloadSpeed, uploadSpeed };

  } catch (error) {
    logger.error(`Speed test error: ${error.message}`);
    return { downloadSpeed: 0, uploadSpeed: 0 };
  }
}

async function reportResults(token, downloadSpeed, uploadSpeed, location) {
  try {
    logger.info('Submitting test results...');

    const proxyAgent = await getProxyAgent(token);
    const response = await fetch(`${config.baseUrl}/v1/api/points`, {
      method: 'POST',
      headers: {
        ...getCommonHeaders(token),
        'Content-Type': 'application/json'
      },
      agent: proxyAgent,
      timeout: 30000,
      body: JSON.stringify({
        download_speed: Math.round(downloadSpeed * 100) / 100,
        upload_speed: Math.round(uploadSpeed * 100) / 100,
        latitude: location.latitude,
        longitude: location.longitude,
        timestamp: new Date().toISOString()
      })
    });

    if (!response.ok) {
      throw new Error(`Report failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.success) {
      logger.success('Results submitted successfully');
      return data;
    } else {
      throw new Error(data.message || 'Report failed');
    }

  } catch (error) {
    logger.error(`Error submitting results: ${error.message}`);
    return null;
  }
}

// Display account information
async function displayAccountInfo(token) {
  try {
    logger.info('\n=== Account Information ===');
    
    const proxyAgent = await getProxyAgent(token);
    const profileResponse = await fetch(`${config.baseUrl}/v1/api/auth/profile`, {
      headers: getCommonHeaders(token),
      agent: proxyAgent,
      timeout: 30000
    });

    if (profileResponse.ok) {
      const profile = await profileResponse.json();
      logger.info(`Username: ${profile.data.username || "Not set"}`);
      logger.info(`Email: ${profile.data.email || "Not set"}`);
    }
    
    logger.info('=== ==================== ===\n');
  } catch (error) {
    logger.error(`Failed to get account information: ${error.message}`);
  }
}

// Process single account
async function processAccount(token, accountIndex) {
  try {
    logger.info(`\n=== Processing Account ${accountIndex + 1} ===`);
    logger.time(`Time: ${new Date().toLocaleString()}`);
    
    const isValid = await validateToken(token);
    if (!isValid) {
      logger.error(`Token ${accountIndex + 1} is invalid or expired`);
      return false;
    }
    logger.success(`Token ${accountIndex + 1} validation successful`);
    
    await displayAccountInfo(token);
    
    const location = generateRandomLocation();
    logger.location(`Speed test location: ${location.latitude}, ${location.longitude}`);
    
    logger.network('Starting speed test...');
    const { downloadSpeed, uploadSpeed } = await performSpeedTest();
    logger.speed(`Final Download speed: ${downloadSpeed.toFixed(2)} Mbps`);
    logger.speed(`Final Upload speed: ${uploadSpeed.toFixed(2)} Mbps`);
    
    const result = await reportResults(token, downloadSpeed, uploadSpeed, location);
    
    if (result && result.success) {
      logger.success('Speed test completed and results reported');
      return true;
    } else {
      logger.error('Failed to report results');
      if (result && result.message) {
        logger.error(`Failure reason: ${result.message}`);
      }
      return false;
    }
    
  } catch (error) {
    logger.error(`Error processing account ${accountIndex + 1}: ${error.message}`);
    if (error.response) {
      try {
        const errorData = await error.response.json();
        logger.error(`Server response: ${JSON.stringify(errorData)}`);
      } catch {
        logger.error(`Status code: ${error.response.status}`);
      }
    }
    return false;
  }
}

// Main loop
async function main() {
  try {
    logger.info('\n=== Starting multi-account speed test ===');
    
    for (let i = 0; i < config.tokens.length; i++) {
      await processAccount(config.tokens[i], i);
      
      // Add delay between accounts
      if (i < config.tokens.length - 1) {
        logger.info('Waiting 30 seconds before processing next account...');
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
    
  } catch (error) {
    logger.error(`Error during main loop: ${error.message}`);
  } finally {
    const nextTime = new Date(Date.now() + config.checkInterval);
    logger.time(`Next test cycle scheduled for: ${nextTime.toLocaleString()}`);
    logger.info(`Interval: ${Math.round(config.checkInterval / 1000 / 60)} minutes`);
    logger.info('=== Speed test cycle complete ===\n');
    setTimeout(main, config.checkInterval);
  }
}

// Handle process exit
process.on('SIGINT', () => {
  logger.warning('\nReceived exit signal');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.warning('\nReceived terminate signal');
  process.exit(0);
});

// Start the program
console.clear();
logger.info('Initializing Multi-Account DeSpeed Test Client...');
initConfig().then(() => {
  main();
}).catch(error => {
  logger.error(`Initialization error: ${error.message}`);
  process.exit(1);
});
