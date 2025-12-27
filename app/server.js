const express = require('express');
const redis = require('redis');
const cors = require('cors');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

// Container ID for load balancing demo
const CONTAINER_ID = process.env.HOSTNAME || os.hostname();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Auth Middleware
const checkAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'];
  if (password === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid password' });
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Redis Client
const redisClient = redis.createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT
  }
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('✅ Connected to Redis'));

// Connect to Redis
(async () => {
  await redisClient.connect();
})();

// ==================== API ENDPOINTS ====================

// Health check (for load balancer)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    container: CONTAINER_ID,
    timestamp: new Date().toISOString()
  });
});

// Get current voting session
app.get('/api/voting/current', async (req, res) => {
  try {
    const votingData = await redisClient.get('voting:current');

    if (!votingData) {
      return res.json({ exists: false });
    }

    const voting = JSON.parse(votingData);
    res.json({ exists: true, voting });
  } catch (error) {
    console.error('Error getting current voting:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new voting session (Admin only)
app.post('/api/voting/create', checkAuth, async (req, res) => {
  try {
    const { title, candidates } = req.body;

    if (!title || !candidates || candidates.length < 2) {
      return res.status(400).json({ error: 'Title and at least 2 candidates required' });
    }

    // Check if voting already exists
    const existing = await redisClient.get('voting:current');
    if (existing) {
      return res.status(400).json({ error: 'Voting already exists. Delete current voting first.' });
    }

    const voting = {
      id: Date.now().toString(),
      title,
      candidates,
      is_active: false,
      created_at: new Date().toISOString()
    };

    // Save to Redis
    await redisClient.set('voting:current', JSON.stringify(voting));

    // Initialize vote counters
    for (const candidate of candidates) {
      await redisClient.set(`votes:${candidate.id}`, 0);
    }

    res.json({ success: true, voting });
  } catch (error) {
    console.error('Error creating voting:', error);
    res.status(500).json({ error: 'Failed to create voting' });
  }
});

// Start voting
app.post('/api/voting/start', checkAuth, async (req, res) => {
  try {
    const votingData = await redisClient.get('voting:current');

    if (!votingData) {
      return res.status(404).json({ error: 'No voting found' });
    }

    const voting = JSON.parse(votingData);
    voting.is_active = true;

    await redisClient.set('voting:current', JSON.stringify(voting));

    res.json({ success: true, message: 'Voting started' });
  } catch (error) {
    console.error('Error starting voting:', error);
    res.status(500).json({ error: 'Failed to start voting' });
  }
});

// Stop voting
app.post('/api/voting/stop', checkAuth, async (req, res) => {
  try {
    const votingData = await redisClient.get('voting:current');

    if (!votingData) {
      return res.status(404).json({ error: 'No voting found' });
    }

    const voting = JSON.parse(votingData);
    voting.is_active = false;

    await redisClient.set('voting:current', JSON.stringify(voting));

    res.json({ success: true, message: 'Voting stopped' });
  } catch (error) {
    console.error('Error stopping voting:', error);
    res.status(500).json({ error: 'Failed to stop voting' });
  }
});

// Delete voting
app.delete('/api/voting/delete', checkAuth, async (req, res) => {
  try {
    const votingData = await redisClient.get('voting:current');

    if (!votingData) {
      return res.status(404).json({ error: 'No voting found' });
    }

    const voting = JSON.parse(votingData);

    // Delete vote counters
    for (const candidate of voting.candidates) {
      await redisClient.del(`votes:${candidate.id}`);
    }

    // Delete all voters
    const voterKeys = await redisClient.keys('voter:*');
    if (voterKeys.length > 0) {
      await redisClient.del(voterKeys);
    }

    // Delete voting
    await redisClient.del('voting:current');

    res.json({ success: true, message: 'Voting deleted' });
  } catch (error) {
    console.error('Error deleting voting:', error);
    res.status(500).json({ error: 'Failed to delete voting' });
  }
});

// Submit vote
app.post('/api/vote', async (req, res) => {
  try {
    const { email, candidate_id } = req.body;

    if (!email || !candidate_id) {
      return res.status(400).json({ error: 'Email and candidate_id required' });
    }

    // Check if voting is active
    const votingData = await redisClient.get('voting:current');
    if (!votingData) {
      return res.status(404).json({ error: 'No active voting found' });
    }

    const voting = JSON.parse(votingData);
    if (!voting.is_active) {
      return res.status(400).json({ error: 'Voting is not active' });
    }

    // Check if email already voted
    const hasVoted = await redisClient.get(`voter:${email}`);
    if (hasVoted) {
      return res.status(400).json({ error: 'Email already voted' });
    }

    // Verify candidate exists
    const candidateExists = voting.candidates.some(c => c.id === candidate_id);
    if (!candidateExists) {
      return res.status(400).json({ error: 'Invalid candidate' });
    }

    // Record vote
    await redisClient.set(`voter:${email}`, candidate_id);

    // Increment vote counter (atomic operation)
    await redisClient.incr(`votes:${candidate_id}`);

    res.json({
      success: true,
      message: 'Vote recorded',
      container: CONTAINER_ID
    });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

// Get voting results
app.get('/api/results', async (req, res) => {
  try {
    const votingData = await redisClient.get('voting:current');

    if (!votingData) {
      return res.json({
        total_votes: 0,
        candidates: [],
        container: CONTAINER_ID
      });
    }

    const voting = JSON.parse(votingData);

    // Get vote counts
    const results = [];
    let totalVotes = 0;

    for (const candidate of voting.candidates) {
      const votes = parseInt(await redisClient.get(`votes:${candidate.id}`) || '0');
      totalVotes += votes;
      results.push({
        id: candidate.id,
        name: candidate.name,
        votes: votes
      });
    }

    // Calculate percentages
    const candidatesWithPercentage = results.map(c => ({
      ...c,
      percentage: totalVotes > 0 ? (c.votes / totalVotes) * 100 : 0
    }));

    res.json({
      total_votes: totalVotes,
      candidates: candidatesWithPercentage,
      container: CONTAINER_ID
    });
  } catch (error) {
    console.error('Error getting results:', error);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

// Get votes for old landing page (backward compatibility)
app.get('/api/votes', async (req, res) => {
  try {
    // For demo purposes with hardcoded options
    const option1 = parseInt(await redisClient.get('demo:option1') || '0');
    const option2 = parseInt(await redisClient.get('demo:option2') || '0');

    res.json({
      votes: {
        option1,
        option2
      },
      container: CONTAINER_ID
    });
  } catch (error) {
    console.error('Error getting votes:', error);
    res.status(500).json({ error: 'Failed to get votes' });
  }
});

// Submit vote for demo (old landing page)
app.post('/api/vote-demo', async (req, res) => {
  try {
    const { option } = req.body;

    if (!option || !['option1', 'option2'].includes(option)) {
      return res.status(400).json({ error: 'Invalid option' });
    }

    // Increment vote counter
    await redisClient.incr(`demo:${option}`);

    res.json({
      success: true,
      message: 'Vote recorded',
      container: CONTAINER_ID
    });
  } catch (error) {
    console.error('Error submitting vote:', error);
    res.status(500).json({ error: 'Failed to submit vote' });
  }
});

// Catch-all route - serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
    🚀 QuickVote Server Started!
    📍 Port: ${PORT}
    🐳 Container: ${CONTAINER_ID}
    🔴 Redis: ${REDIS_HOST}:${REDIS_PORT}
    `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  await redisClient.disconnect();
  process.exit(0);
});
