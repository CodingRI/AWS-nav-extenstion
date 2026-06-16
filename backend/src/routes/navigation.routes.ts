import { Router } from 'express';
import type { Request, Response } from 'express';
import type { NextStepRequest } from '@aws-nav/shared';
import { aiService } from '../services/ai.service.ts';

const router = Router();

/**
 * POST /api/next-step
 * Generate the next navigation step based on current page context.
 * 
 * This is the PRIMARY endpoint. The content script sends:
 * - goal: what the user wants to accomplish
 * - pageContext: full DOM context (visible elements, breadcrumbs, etc.)
 * - history: previously completed steps
 * - sessionId: optional session identifier
 */
router.post('/next-step', async (req: Request, res: Response) => {
  try {
    const { goal, pageContext, history, sessionId }: NextStepRequest = req.body;

    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Goal is required and must be a string',
      });
    }

    if (!pageContext || typeof pageContext !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'pageContext is required',
      });
    }

    console.log('[Route /next-step] ────────────────────────────');
    console.log('[Route /next-step] Goal:', goal);
    console.log('[Route /next-step] Service:', pageContext.service);
    console.log('[Route /next-step] View:', pageContext.view);
    console.log('[Route /next-step] Visible elements:', pageContext.visibleButtons?.length || 0);
    console.log('[Route /next-step] History:', history?.length || 0, 'steps');
    console.log('[Route /next-step] Session:', sessionId || 'none');
    // Log ALL elements sent to AI
    console.log(`[Route /next-step] All ${(pageContext.visibleButtons || []).length} elements sent to AI:`);
    (pageContext.visibleButtons || []).forEach((el: any, i: number) => {
      console.log(`  ${i + 1}. [${el.tagName}] "${el.text || el.ariaLabel || '(no label)'}"`);
    });

    const result = await aiService.generateNextStep({
      goal,
      pageContext,
      history: history || [],
      ...(sessionId != null ? { sessionId } : {}),
    });

    console.log('[Route /next-step] Result:', {
      success: result.success,
      stepsCount: result.steps?.length,
      firstInstruction: result.steps?.[0]?.instruction?.substring(0, 60),
      isComplete: result.isComplete,
    });
    console.log('[Route /next-step] ────────────────────────────');

    res.json(result);

  } catch (error) {
    console.error('[Route /next-step] Error:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
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
    service: 'AWS Navigation Backend v2',
    mode: 'context-aware-single-step',
  });
});

export default router;