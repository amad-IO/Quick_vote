const http = require('http');

// Configuration
const CONFIG = {
  target: 'http://localhost', // URL of the Load Balancer
  duration: 10,               // Test duration in seconds
  concurrency: 50,            // Number of concurrent requests
  endpoints: {
    health: '/api/health',  // To check load balancing
    results: '/api/results' // To check read performance
  }
};

// Statistics
const stats = {
  totalRequests: 0,
  successful: 0,
  failed: 0,
  containers: {}, // Track which container handled the request
  startTime: Date.now()
};

console.log(`
🚀 QuickVote Stress Test Started
==============================
Target: ${CONFIG.target}
Concurrency: ${CONFIG.concurrency} users
Duration: ${CONFIG.duration} seconds
`);

let activeRequests = 0;
let shouldStop = false;

// Function to make a request
function makeRequest() {
  if (shouldStop) return;

  activeRequests++;
  stats.totalRequests++;

  const req = http.get(`${CONFIG.target}${CONFIG.endpoints.health}`, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      if (res.statusCode === 200) {
        stats.successful++;
        try {
          const json = JSON.parse(data);
          if (json.container) {
            stats.containers[json.container] = (stats.containers[json.container] || 0) + 1;
          }
        } catch (e) {
          // Ignore JSON parse errors for stats
        }
      } else {
        stats.failed++;
      }
      activeRequests--;
      if (!shouldStop) makeRequest(); // Keep the loop going
    });
  });

  req.on('error', (e) => {
    stats.failed++;
    activeRequests--;
    if (!shouldStop) makeRequest();
  });
}

// Start the simulation
for (let i = 0; i < CONFIG.concurrency; i++) {
  makeRequest();
}

// Stop after duration
setTimeout(() => {
  shouldStop = true;

  // Wait for active requests to finish (optional, but clean)
  console.log('\n🛑 Stopping test...');

  setTimeout(() => {
    printResults();
  }, 1000);

}, CONFIG.duration * 1000);

function printResults() {
  const duration = (Date.now() - stats.startTime) / 1000;
  const rps = (stats.successful / duration).toFixed(2);

  console.log(`
📊 Test Results
==============================
Total Requests: ${stats.totalRequests}
Successful:     ${stats.successful} ✅
Failed:         ${stats.failed} ❌
Duration:       ${duration.toFixed(2)}s
Throughput:     ${rps} req/sec

🐳 Load Balancing Distribution:
------------------------------`);

  Object.entries(stats.containers).forEach(([id, count]) => {
    const percentage = ((count / stats.successful) * 100).toFixed(1);
    console.log(`- Container ${id}: ${count} requests (${percentage}%)`);
  });

  console.log('\n✅ Test Complete!');
  process.exit(0);
}
