import express from 'express';
import type { NextFunction, Express, Request, Response } from 'express';
import cors from 'cors';
import 'dotenv/config';
import navigationRoutes from './routes/navigation.routes.ts';

// Validate required environment variables
if (!process.env.OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY is not set in environment variables');
  console.error('Please create a .env file with your OpenRouter API key');
  process.exit(1);
}

const app: Express = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like Chrome extensions)
    // or from any chrome-extension:// URL
    if (!origin || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for development
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api', navigationRoutes);

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    service: 'AWS Navigation Assistant Backend',
    version: '2.0.0',
    status: 'running',
    mode: 'dynamic-step-generation',
    endpoints: {
      health: '/api/health',
      nextStep: '/api/next-step (POST) - NEW: Dynamic step-by-step',
      navigate: '/api/navigate (POST) - LEGACY: All steps at once',
    },
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[Server Error]:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    path: req.path,
  });
});

// Start server
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('🚀 AWS Navigation Assistant Backend v2.0 (OpenRouter AI)');
  console.log('='.repeat(60));
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✓ OpenRouter API Key configured: ${process.env.OPENROUTER_API_KEY ? 'Yes' : 'No'}`);
  console.log(`✓ Mode: Dynamic step-by-step navigation`);
  console.log('='.repeat(60));
  console.log('\nEndpoints:');
  console.log(`  GET  /              - Service info`);
  console.log(`  GET  /api/health    - Health check`);
  console.log(`  POST /api/next-step - Generate next step (NEW)`);
  console.log(`  POST /api/navigate  - Generate all steps (LEGACY)`);
  console.log('='.repeat(60));
});

export default app;