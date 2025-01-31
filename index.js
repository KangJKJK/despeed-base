const fetch = require("node-fetch");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const readline = require("readline");
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs').promises;
const kleur = require('kleur');

// 설정
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

// 현대적인 콘솔 출력 도우미
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

// 파일에서 토큰 읽기
async function loadTokensFromFile() {
  try {
    const content = await fs.readFile('token.txt', 'utf8');
    const tokens = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    if (tokens.length === 0) {
      throw new Error('token.txt에서 유효한 토큰을 찾을 수 없습니다');
    }
    
    config.tokens = tokens;
    logger.success(`token.txt에서 ${tokens.length}개의 토큰을 로드했습니다`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error('token.txt 파일을 찾을 수 없습니다');
    } else {
      logger.error(`토큰 파일 읽기 오류: ${error.message}`);
    }
    return false;
  }
}

// 파일에서 프록시 읽기
async function loadProxyFromFile() {
  try {
    const proxyContent = await fs.readFile('proxy.txt', 'utf8');
    const proxies = proxyContent.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    
    if (proxies.length === 0) {
      logger.error('proxy.txt 파일에 유효한 프록시가 없습니다');
      return null;
    }

    // 프록시 URL 형식 변환
    config.proxies = proxies.map(proxyUrl => {
      // smartproxy 형식을 http 프록시 URL로 변환
      if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
        return `http://${proxyUrl}`;
      }
      return proxyUrl;
    });

    logger.success(`${config.proxies.length}개의 프록시를 성공적으로 로드했습니다`);
    logger.info('프록시 형식 예시:');
    logger.info(`- 원본: ${proxies[0]}`);
    logger.info(`- 변환: ${config.proxies[0]}`);
    
    config.proxy.enabled = true;
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error('proxy.txt 파일을 찾을 수 없습니다');
    } else {
      logger.error(`프록시 파일 읽기 오류: ${error.message}`);
    }
    return null;
  }
}

// 프록시 그룹 설정 함수 수정
async function setupProxyGroups(tokens, proxies) {
  if (!proxies || proxies.length === 0) {
    logger.error('사용 가능한 프록시가 없습니다');
    return;
  }

  logger.info(`토큰 수: ${tokens.length}, 프록시 수: ${proxies.length}`);
  
  // 토큰당 프록시 개수 계산 (균등 분배)
  const proxiesPerToken = Math.floor(proxies.length / tokens.length);
  const remainingProxies = proxies.length % tokens.length;
  
  logger.info('프록시 분배 방식:');
  logger.info(`- 각 토큰당 기본 할당: ${proxiesPerToken}개`);
  if (remainingProxies > 0) {
    logger.info(`- 마지막 토큰에 추가 할당될 프록시: ${remainingProxies}개`);
    logger.info(`- 마지막 토큰의 총 프록시 수: ${proxiesPerToken + remainingProxies}개`);
  }
  
  tokens.forEach((token, index) => {
    const startIndex = index * proxiesPerToken;
    const endIndex = index === tokens.length - 1 
      ? proxies.length  // 마지막 토큰은 남은 모든 프록시 할당
      : startIndex + proxiesPerToken;
    
    config.proxyGroups[token] = proxies.slice(startIndex, endIndex);
    config.currentProxyIndices[token] = 0;
  });

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

// 설정 초기화
async function initConfig() {
  logger.info('설정 초기화 중...');

  const tokensLoaded = await loadTokensFromFile();
  if (!tokensLoaded) {
    throw new Error('token.txt 파일에서 토큰을 로드하는데 실패했습니다');
  }

  const proxyFileExists = await loadProxyFromFile();
  if (proxyFileExists) {
    logger.success('proxy.txt에서 프록시 설정을 로드했습니다');
    config.proxy.enabled = true;
    await setupProxyGroups(config.tokens, config.proxies);
  } else {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const question = (query) => new Promise((resolve) => rl.question(query, resolve));

    const useProxy = (await question(kleur.cyan('프록시를 사용하시겠습니까? (y/n): '))).toLowerCase() === 'y';
    if (useProxy) {
      config.proxy.enabled = true;
      const proxyUrl = await question(kleur.cyan('프록시 URL을 입력하세요 (예: http://user:pass@ip:port 또는 socks5://ip:port): '));
      config.proxy.url = proxyUrl;
      
      if (proxyUrl.startsWith('socks4://')) {
        config.proxy.type = 'socks4';
      } else if (proxyUrl.startsWith('socks5://')) {
        config.proxy.type = 'socks5';
      } else {
        config.proxy.type = 'http';
      }
    }

    const interval = await question(kleur.cyan('검사 간격을 입력하세요 (분, 기본값 1): '));
    config.checkInterval = (parseInt(interval) || 1) * 60000;

    rl.close();
  }

  logger.success('설정이 완료되었습니다!');
  logger.info('현재 설정:');
  const safeConfig = {...config, tokens: `${config.tokens.length}개의 토큰이 로드됨`};
  console.log(kleur.gray(JSON.stringify(safeConfig, null, 2)));
}

// 일반적인 헤더 가져오기
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

// 토큰 유효성 검사
async function validateToken(token) {
  if (!token) {
    throw new Error('토큰을 찾을 수 없습니다');
  }
  
  try {
    const tokenData = JSON.parse(atob(token.split('.')[1]));
    if ((tokenData.exp - 90) * 1000 < Date.now()) {
      throw new Error('토큰이 만료되었습니다');
    }

    const proxyAgent = await getProxyAgent(token);
    const profileResponse = await fetch(`${config.baseUrl}/v1/api/auth/profile`, {
      headers: getCommonHeaders(token),
      agent: proxyAgent,
      timeout: 30000
    });

    if (!profileResponse.ok) {
      throw new Error('유효하지 않은 토큰입니다');
    }

    return true;
  } catch (error) {
    logger.error(`토큰 검증 실패: ${error.message}`);
    return false;
  }
}

// 속도 테스트 수행
async function performSpeedTest() {
  try {
    logger.network('네트워크 속도 측정을 시작합니다...');
    
    const metadata = {
      client_name: 'speed-measurementlab-net-1',
      client_session_id: crypto.randomUUID()
    };

    const proxyAgent = await getProxyAgent();
    
    const locateUrl = new URL('https://locate.measurementlab.net/v2/nearest/ndt/ndt7');
    locateUrl.search = new URLSearchParams(metadata).toString();
    
    logger.info('속도 테스트 서버를 찾는 중...');
    const locateResponse = await fetch(locateUrl, {
      agent: proxyAgent,
      timeout: 30000
    });

    if (!locateResponse.ok) {
      throw new Error(`속도 테스트 서버 찾기 실패: ${locateResponse.status}`);
    }

    const serverData = await locateResponse.json();
    if (!serverData.results || !serverData.results[0]) {
      throw new Error('사용 가능한 속도 테스트 서버가 없습니다');
    }

    const server = serverData.results[0];
    logger.success(`선택된 서버: ${server.machine}`);

    const downloadUrl = server.urls['wss:///ndt/v7/download'];
    const uploadUrl = server.urls['wss:///ndt/v7/upload'];

    // 다운로드 테스트
    logger.network('다운로드 테스트 시작...');
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

    // 업로드 테스트
    logger.network('업로드 테스트 시작...');
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
    logger.error(`속도 테스트 오류: ${error.message}`);
    return { downloadSpeed: 0, uploadSpeed: 0 };
  }
}

// 결과 보고
async function reportResults(token, downloadSpeed, uploadSpeed, location) {
  try {
    logger.info('테스트 결과를 제출하는 중...');

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
      throw new Error(`결과 제출 실패: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.success) {
      logger.success('결과가 성공적으로 제출되었습니다');
      return data;
    } else {
      throw new Error(data.message || '결과 제출 실패');
    }

  } catch (error) {
    logger.error(`결과 제출 오류: ${error.message}`);
    return null;
  }
}

// 계정 정보 표시
async function displayAccountInfo(token) {
  try {
    logger.info('\n=== 계정 정보 ===');
    
    const proxyAgent = await getProxyAgent(token);
    const profileResponse = await fetch(`${config.baseUrl}/v1/api/auth/profile`, {
      headers: getCommonHeaders(token),
      agent: proxyAgent,
      timeout: 30000
    });

    if (profileResponse.ok) {
      const profile = await profileResponse.json();
      logger.info(`사용자명: ${profile.data.username || "설정되지 않음"}`);
      logger.info(`이메일: ${profile.data.email || "설정되지 않음"}`);
    }
    
    logger.info('=== ============ ===\n');
  } catch (error) {
    logger.error(`계정 정보 가져오기 실패: ${error.message}`);
  }
}

// 단일 계정 처리
async function processAccount(token, accountIndex) {
  try {
    logger.info(`\n=== 계정 ${accountIndex + 1} 처리 중 ===`);
    logger.time(`시간: ${new Date().toLocaleString()}`);
    
    const isValid = await validateToken(token);
    if (!isValid) {
      logger.error(`토큰 ${accountIndex + 1}이(가) 유효하지 않거나 만료되었습니다`);
      return false;
    }
    logger.success(`토큰 ${accountIndex + 1} 검증 성공`);
    
    await displayAccountInfo(token);
    
    const location = generateRandomLocation();
    logger.location(`속도 테스트 위치: ${location.latitude}, ${location.longitude}`);
    
    logger.network('속도 테스트 시작...');
    const { downloadSpeed, uploadSpeed } = await performSpeedTest();
    logger.speed(`최종 다운로드 속도: ${downloadSpeed.toFixed(2)} Mbps`);
    logger.speed(`최종 업로드 속도: ${uploadSpeed.toFixed(2)} Mbps`);
    
    const result = await reportResults(token, downloadSpeed, uploadSpeed, location);
    
    if (result && result.success) {
      logger.success('속도 테스트 완료 및 결과 보고됨');
      return true;
    } else {
      logger.error('결과 보고 실패');
      if (result && result.message) {
        logger.error(`실패 이유: ${result.message}`);
      }
      return false;
    }
    
  } catch (error) {
    logger.error(`계정 ${accountIndex + 1} 처리 중 오류 발생: ${error.message}`);
    if (error.response) {
      try {
        const errorData = await error.response.json();
        logger.error(`서버 응답: ${JSON.stringify(errorData)}`);
      } catch {
        logger.error(`상태 코드: ${error.response.status}`);
      }
    }
    return false;
  }
}

// 메인 루프
async function main() {
  try {
    logger.info('\n=== 다중 계정 속도 테스트 시작 ===');
    
    for (let i = 0; i < config.tokens.length; i++) {
      await processAccount(config.tokens[i], i);
      
      // 계정 간 딜레이 추가
      if (i < config.tokens.length - 1) {
        logger.info('다음 계정 처리까지 30초 대기 중...');
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
    
  } catch (error) {
    logger.error(`메인 루프 중 오류 발생: ${error.message}`);
  } finally {
    const nextTime = new Date(Date.now() + config.checkInterval);
    logger.time(`다음 테스트 주기 예정 시간: ${nextTime.toLocaleString()}`);
    logger.info(`간격: ${Math.round(config.checkInterval / 1000 / 60)}분`);
    logger.info('=== 속도 테스트 주기 완료 ===\n');
    setTimeout(main, config.checkInterval);
  }
}

// 프로세스 종료 처리
process.on('SIGINT', () => {
  logger.warning('\n종료 신호를 받았습니다');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.warning('\n종료 신호를 받았습니다');
  process.exit(0);
});

// 프로그램 시작
console.clear();
logger.info('다중 계정 DeSpeed 테스트 클라이언트 초기화 중...');
initConfig().then(() => {
  main();
}).catch(error => {
  logger.error(`초기화 오류: ${error.message}`);
  process.exit(1);
});
