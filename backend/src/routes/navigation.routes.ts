import { Router } from 'express';
import type { Request, Response } from 'express';
import type { NavigationRequest, NavigationResponse } from '@aws-nav/shared';
import { aiService } from '../services/ai.service.ts';

const router = Router();

/**
 * POST /api/next-step
 * Generate the next navigation step based on current page context (NEW DYNAMIC ENDPOINT)
 */
router.post('/next-step', async (req: Request, res: Response) => {
  try {
    const { goal, history, currentPage, availableActions } = req.body;

    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Goal is required and must be a string',
      });
    }

    console.log('[Next Step] Goal:', goal);
    console.log('[Next Step] Current page:', currentPage?.service || 'unknown');
    console.log('[Next Step] Available actions:', availableActions?.length || 0);
    console.log('[Next Step] Steps completed:', history?.length || 0);

    // Generate next step using AI
    const result = await aiService.generateNextStep({
      goal,
      history: history || [],
      currentPage: currentPage || {
        url: '',
        title: '',
        service: 'unknown',
        breadcrumbs: [],
      },
      availableActions: availableActions || [],
    });

    console.log('[Next Step] Generated:', result.instruction);

    res.json({
      success: true,
      data: {
        nextInstruction: result.instruction,
      },
    });

  } catch (error) {
    console.error('[Next Step] Error:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * POST /api/navigate
 * Generate navigation steps for a given query (LEGACY ENDPOINT - kept for compatibility)
 */
router.post('/navigate', async (req: Request, res: Response) => {
  try {
    const { query, currentPage }: NavigationRequest = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Query is required and must be a string',
      });
    }

    console.log('[Navigation Route] Generating steps for query:', query);
    console.log('[Navigation Route] Current page:', currentPage);

    // Generate navigation steps using AI
    const result = await aiService.generateNavigationSteps(query);

    const response: NavigationResponse = {
      success: true,
      steps: result.steps,
      summary: result.summary,
      estimatedTime: `${result.steps.length * 30} seconds`,
    };

    console.log('[Navigation Route] Generated', result.steps.length, 'steps');
    
    res.json(response);
  } catch (error) {
    console.error('[Navigation Route] Error:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      steps: [],
      summary: '',
    } as NavigationResponse);
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'AWS Navigation Backend',
  });
});

export default router;