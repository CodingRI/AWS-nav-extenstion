// ============================================================
// Phase 1 — Context Grabber
// Scans the current AWS Console page to build a PageContext
// object that gets sent to the AI for step generation.
// ============================================================

import type { PageContext, InteractiveElement } from "@aws-nav/shared";

// AWS service patterns extracted from URLs
const SERVICE_PATTERNS: Record<string, string> = {
  "/ec2/": "EC2",
  "/s3/": "S3",
  "/iam/": "IAM",
  "/lambda/": "Lambda",
  "/rds/": "RDS",
  "/dynamodb/": "DynamoDB",
  "/cloudformation/": "CloudFormation",
  "/cloudwatch/": "CloudWatch",
  "/vpc/": "VPC",
  "/ecs/": "ECS",
  "/eks/": "EKS",
  "/sqs/": "SQS",
  "/sns/": "SNS",
  "/apigateway/": "API Gateway",
  "/elasticbeanstalk/": "Elastic Beanstalk",
  "/route53/": "Route 53",
  "/cloudfront/": "CloudFront",
  "/cognito/": "Cognito",
  "/secretsmanager/": "Secrets Manager",
  "/kms/": "KMS",
  "/ecr/": "ECR",
  "/athena/": "Athena",
  "/glue/": "Glue",
  "/redshift/": "Redshift",
  "/kinesis/": "Kinesis",
  "/sagemaker/": "SageMaker",
  "/codecommit/": "CodeCommit",
  "/codepipeline/": "CodePipeline",
  "/codebuild/": "CodeBuild",
  "/codedeploy/": "CodeDeploy",
  "/console/home": "Console Home",
};

const MAX_INTERACTIVE_ELEMENTS = 50;

/**
 * Master function — grabs full page context from the current DOM.
 * Runs Phase 1 of the architecture: URL parse + DOM scan + breadcrumb/form capture.
 */
export function grabPageContext(): PageContext {
  const url = window.location.href;
  const service = parseAWSService(url);
  const title = document.title;
  const visibleButtons = scanInteractiveElements();
  const breadcrumb = captureBreadcrumb();
  const formState = captureFormState();

  // Derive "view" from title + breadcrumb
  const view = deriveView(title, breadcrumb, url);

  const context: PageContext = {
    url,
    service,
    view,
    title,
    visibleButtons,
    breadcrumb,
    formState,
  };

  console.log("[ContextGrabber] Page context captured:", {
    service: context.service,
    view: context.view,
    elements: context.visibleButtons.length,
    breadcrumb: context.breadcrumb,
  });

  return context;
}

/**
 * Extract AWS service name from URL path.
 */
export function parseAWSService(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();

    for (const [pattern, name] of Object.entries(SERVICE_PATTERNS)) {
      if (pathname.includes(pattern.toLowerCase())) {
        return name;
      }
    }

    // Fallback: try to extract from subdomain (e.g. s3.console.aws.amazon.com)
    const hostname = new URL(url).hostname;
    const subdomain = hostname.split(".")[0];
    if (subdomain && subdomain !== "console" && subdomain !== "www") {
      return subdomain.toUpperCase();
    }

    return "AWS Console";
  } catch {
    return "Unknown";
  }
}

/**
 * Scan DOM for visible, interactive elements using STABLE selectors only.
 * Returns the top N elements sorted by likely importance.
 */
export function scanInteractiveElements(): InteractiveElement[] {
  const elements: InteractiveElement[] = [];
  const seen = new Set<Element>();

  // Strategy 1: Elements with aria-label (most reliable on AWS)
  collectElements(
    document.querySelectorAll("[aria-label]"),
    elements,
    seen
  );

  // Strategy 2: Elements with data-analytics metadata
  collectElements(
    document.querySelectorAll("[data-analytics-metadata]"),
    elements,
    seen
  );

  // Strategy 3: Role-based elements
  collectElements(
    document.querySelectorAll(
      'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"]'
    ),
    elements,
    seen
  );

  // Strategy 4: Input elements and selects
  collectElements(
    document.querySelectorAll("input, select, textarea"),
    elements,
    seen
  );

  // Limit to top N
  return elements.slice(0, MAX_INTERACTIVE_ELEMENTS);
}

/**
 * Collect elements from a NodeList into the results array,
 * deduplicating and filtering out invisible / extension-owned elements.
 */
function collectElements(
  nodeList: NodeListOf<Element>,
  results: InteractiveElement[],
  seen: Set<Element>
): void {
  for (const el of Array.from(nodeList)) {
    if (seen.has(el)) continue;
    if (results.length >= MAX_INTERACTIVE_ELEMENTS) break;

    const htmlEl = el as HTMLElement;

    // Skip our own extension UI
    if (isExtensionUI(htmlEl)) continue;

    // Skip invisible elements
    if (!isVisible(htmlEl)) continue;

    // Skip disabled elements
    if (
      htmlEl.hasAttribute("disabled") ||
      htmlEl.getAttribute("aria-disabled") === "true"
    ) {
      continue;
    }

    seen.add(el);

    const text = getVisibleText(htmlEl);
    // Skip elements with no text or aria-label (not useful for AI)
    if (
      !text &&
      !htmlEl.getAttribute("aria-label") &&
      !htmlEl.getAttribute("data-analytics-metadata")
    ) {
      continue;
    }

    results.push({
      tagName: htmlEl.tagName.toLowerCase(),
      text: text.substring(0, 100), // cap text length
      ariaLabel: htmlEl.getAttribute("aria-label"),
      dataAnalytics: htmlEl.getAttribute("data-analytics-metadata"),
      role: htmlEl.getAttribute("role"),
      selector: buildStableSelector(htmlEl),
      isVisible: true,
    });
  }
}

/**
 * Get visible text content of an element (direct text, not children's deep text).
 * Prefers: aria-label > title > direct textContent (trimmed, shallow).
 */
function getVisibleText(el: HTMLElement): string {
  // Try aria-label first
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();

  // Try title attribute
  const title = el.getAttribute("title");
  if (title) return title.trim();

  // Try placeholder for inputs
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && el.tagName === "INPUT") return `[input: ${placeholder}]`;

  // Shallow text content (avoids pulling in nested elements' text)
  const text = (el.textContent || "").trim();
  return text.length > 100 ? text.substring(0, 100) + "…" : text;
}

/**
 * Build the most stable CSS selector for an element.
 * Priority: [aria-label] > [data-testid] > [data-analytics-metadata] > id > tag+nth-child
 */
function buildStableSelector(el: HTMLElement): string {
  // aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    return `[aria-label="${CSS.escape(ariaLabel)}"]`;
  }

  // data-testid
  const testId = el.getAttribute("data-testid");
  if (testId) {
    return `[data-testid="${CSS.escape(testId)}"]`;
  }

  // data-analytics-metadata
  const analytics = el.getAttribute("data-analytics-metadata");
  if (analytics) {
    return `[data-analytics-metadata="${CSS.escape(analytics)}"]`;
  }

  // id
  if (el.id) {
    return `#${CSS.escape(el.id)}`;
  }

  // Fallback: tag + nth-of-type
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName
    );
    const index = siblings.indexOf(el) + 1;
    return `${tag}:nth-of-type(${index})`;
  }

  return tag;
}

/**
 * Capture breadcrumb navigation from AWS Console.
 */
export function captureBreadcrumb(): string[] {
  const breadcrumbs: string[] = [];

  // AWS Console uses various breadcrumb patterns
  const selectors = [
    '[data-testid="breadcrumb"] li',
    '[class*="breadcrumb"] li',
    '[class*="Breadcrumb"] li',
    'nav[aria-label="Breadcrumbs"] li',
    'nav[aria-label="breadcrumbs"] li',
    '[role="navigation"] ol li',
  ];

  for (const selector of selectors) {
    const items = document.querySelectorAll(selector);
    if (items.length > 0) {
      items.forEach((item) => {
        const text = (item.textContent || "").trim();
        if (text && text !== "/" && text !== ">") {
          breadcrumbs.push(text);
        }
      });
      break; // Use the first matching pattern
    }
  }

  return breadcrumbs;
}

/**
 * Capture form state — open modals, active tabs, form field values.
 */
export function captureFormState(): Record<string, string> {
  const state: Record<string, string> = {};

  // Active tab
  const activeTab = document.querySelector(
    '[role="tab"][aria-selected="true"]'
  );
  if (activeTab) {
    state["activeTab"] = (activeTab.textContent || "").trim();
  }

  // Open modal/dialog
  const modal = document.querySelector(
    '[role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"])'
  );
  if (modal) {
    const modalTitle =
      modal.querySelector("h1, h2, h3, [class*='title'], [class*='Title']");
    state["openModal"] = modalTitle
      ? (modalTitle.textContent || "").trim()
      : "Dialog open";
  }

  // Open dropdown
  const dropdown = document.querySelector(
    '[role="listbox"]:not([aria-hidden="true"])'
  );
  if (dropdown) {
    state["openDropdown"] = "true";
  }

  // Filled form fields (first 10)
  const inputs = document.querySelectorAll(
    'input[type="text"], input[type="search"], textarea'
  );
  let fieldCount = 0;
  inputs.forEach((input) => {
    if (fieldCount >= 10) return;
    const htmlInput = input as HTMLInputElement;
    if (htmlInput.value && !isExtensionUI(htmlInput)) {
      const label =
        htmlInput.getAttribute("aria-label") ||
        htmlInput.getAttribute("placeholder") ||
        htmlInput.name ||
        `field_${fieldCount}`;
      state[`form_${label}`] = htmlInput.value.substring(0, 50);
      fieldCount++;
    }
  });

  return state;
}

/**
 * Derive the current "view" from title, breadcrumbs, and URL.
 */
function deriveView(
  title: string,
  breadcrumb: string[],
  url: string
): string {
  // Use breadcrumb if available
  if (breadcrumb.length > 1) {
    return breadcrumb.slice(1).join(" > ");
  }

  // Try to get view from title (remove "AWS" and service prefix)
  const cleanTitle = title
    .replace(/AWS\s*/i, "")
    .replace(/Management Console/i, "")
    .trim();
  if (cleanTitle) {
    return cleanTitle;
  }

  // Fallback: use URL path
  try {
    const path = new URL(url).pathname;
    const segments = path.split("/").filter(Boolean);
    return segments.length > 1 ? segments.slice(1).join(" / ") : "Home";
  } catch {
    return "Unknown view";
  }
}

// ---- Utility Functions ----

function isExtensionUI(el: HTMLElement): boolean {
  let current: HTMLElement | null = el;
  while (current) {
    if (
      current.id === "aws-nav-assistant-root" ||
      current.classList.contains("aws-nav-assistant") ||
      current.classList.contains("aws-nav-highlight-container")
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isVisible(el: HTMLElement): boolean {
  try {
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      (el.offsetWidth > 0 ||
        el.offsetHeight > 0 ||
        el.getClientRects().length > 0)
    );
  } catch {
    return false;
  }
}
