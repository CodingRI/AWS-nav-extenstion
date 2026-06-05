
import type { PageContext, InteractiveElement } from "@aws-nav/shared";


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

// No hard cap — send everything visible to the AI

/* ============================================================
   Master export
   ============================================================ */

export function grabPageContext(): PageContext {
  const url = window.location.href;
  const service = parseAWSService(url);
  const title = document.title;
  const breadcrumb = captureBreadcrumb();
  const formState = captureFormState();
  const view = deriveView(title, breadcrumb, url);

  const visibleButtons = scanAndRankElements();

  const context: PageContext = {
    url,
    service,
    view,
    title,
    visibleButtons,
    breadcrumb,
    formState,
  };

  console.log("[ContextGrabber] Captured context:", {
    service,
    view,
    totalElements: visibleButtons.length,
    top5: visibleButtons.slice(0, 5).map((e) => e.text || e.ariaLabel),
  });

  return context;
}



function scanAndRankElements(): InteractiveElement[] {
  const collected: InteractiveElement[] = [];
  const seen = new Set<Element>();

  const candidates = document.querySelectorAll(
    'button, a[href], [role="button"], [role="link"], [role="tab"], ' +
      '[role="menuitem"], [role="option"], input:not([type="hidden"]), ' +
      'select, textarea'
  );

  for (const el of Array.from(candidates)) {
    if (seen.has(el)) continue;
    seen.add(el);

    const htmlEl = el as HTMLElement;

    if (isExtensionUI(htmlEl)) continue;
    if (!isVisible(htmlEl)) continue;
    if (htmlEl.hasAttribute("disabled")) continue;
    if (htmlEl.getAttribute("aria-disabled") === "true") continue;
    if (htmlEl.getAttribute("aria-hidden") === "true") continue;

    const label = getLabel(htmlEl);

    if (!label) continue;

    if (label.length > 120) continue;

    collected.push({
      tagName: htmlEl.tagName.toLowerCase(),
      text: label.substring(0, 80),
      ariaLabel: htmlEl.getAttribute("aria-label"),
      dataAnalytics: htmlEl.getAttribute("data-analytics-metadata"),
      role: htmlEl.getAttribute("role"),
      selector: buildStableSelector(htmlEl),
      isVisible: true,
    });
  }

  console.log(
    `[ContextGrabber] Found ${collected.length} visible elements. First 5:`,
    collected.slice(0, 5).map((e) => e.text || e.ariaLabel)
  );

  return collected;
}
//helper to find better elements
function findInputLabel(input: HTMLInputElement): string | null {

  const labelledBy = input.getAttribute("aria-labelledby");

if (labelledBy) {
  const labelEl = document.getElementById(labelledBy);

  const text = labelEl?.textContent?.trim();

  if (text) {
    return text;
  }
}
  const aria = input.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();

  const placeholder = input.getAttribute("placeholder");
  if (placeholder?.trim()) return placeholder.trim();

  const id = input.id;
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    const text = label?.textContent?.trim();
    if (text) return text;
  }

  let parent: HTMLElement | null = input.parentElement;

  for (let i = 0; i < 4 && parent; i++) {
    const label = parent.querySelector("label");
    const text = label?.textContent?.trim();

    if (text && text.length < 80) {
      return text;
    }

    parent = parent.parentElement;
  }

  return null;
}

/**
 * Get the most useful label for an element.
 */
function getLabel(el: HTMLElement): string {


  // title attribute
  const title = (el.getAttribute("title") || "").trim();
  if (title) return title;

  // For inputs, use placeholder
  //for seperately labeled renders on AWS 
  const tag = el.tagName;

if (tag === "INPUT") {
  const label = findInputLabel(el as HTMLInputElement);

  if (label) {
    return `[input: ${label}]`;
  }

  const type = el.getAttribute("type") || "text";
  return `[input type=${type}]`;
}

if (tag === "TEXTAREA") {
  const label =
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    "textarea";

  return `[textarea: ${label}]`;
}

if (tag === "SELECT") {
  const label =
    el.getAttribute("aria-label") ||
    el.getAttribute("name") ||
    "dropdown";

  return `[dropdown: ${label}]`;
}

  // Prefer aria-label
  const ariaLabel = (el.getAttribute("aria-label") || "").trim();
  if (ariaLabel) return ariaLabel;

  // Direct text content — prefer shallow text to avoid pulling in children
  const directText = Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => (n.textContent || "").trim())
    .join(" ")
    .trim();
  if (directText && directText.length <= 80) return directText;

  // Full text content, capped
  const fullText = (el.textContent || "").trim();
  return fullText.substring(0, 80);
}

/* ============================================================
   Service / view parsing
   ============================================================ */

export function parseAWSService(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    for (const [pattern, name] of Object.entries(SERVICE_PATTERNS)) {
      if (pathname.includes(pattern.toLowerCase())) return name;
    }
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

function deriveView(title: string, breadcrumb: string[], url: string): string {
  if (breadcrumb.length > 1) return breadcrumb.slice(1).join(" > ");

  const cleanTitle = title
    .replace(/AWS\s*/i, "")
    .replace(/Management Console/i, "")
    .trim();
  if (cleanTitle) return cleanTitle;

  try {
    const path = new URL(url).pathname;
    const segments = path.split("/").filter(Boolean);
    return segments.length > 1 ? segments.slice(1).join(" / ") : "Home";
  } catch {
    return "Unknown view";
  }
}

/* ============================================================
   Breadcrumb & form capture
   ============================================================ */

export function captureBreadcrumb(): string[] {
  const breadcrumbs: string[] = [];
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
        if (text && text !== "/" && text !== ">") breadcrumbs.push(text);
      });
      break;
    }
  }
  return breadcrumbs;
}

export function captureFormState(): Record<string, string> {
  const state: Record<string, string> = {};

  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (activeTab) state["activeTab"] = (activeTab.textContent || "").trim();

  const modal = document.querySelector(
    '[role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"])'
  );
  if (modal) {
    const modalTitle = modal.querySelector("h1, h2, h3, [class*='title']");
    state["openModal"] = modalTitle
      ? (modalTitle.textContent || "").trim()
      : "Dialog open";
  }

  const inputs = document.querySelectorAll(
    'input[type="text"], input[type="search"], textarea'
  );
  let fieldCount = 0;
  inputs.forEach((input) => {
    if (fieldCount >= 5) return;
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

/* ============================================================
   Stable CSS selector builder
   ============================================================ */

function buildStableSelector(el: HTMLElement): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;

  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

  const analytics = el.getAttribute("data-analytics-metadata");
  if (analytics) return `[data-analytics-metadata="${CSS.escape(analytics)}"]`;

  if (el.id) return `#${CSS.escape(el.id)}`;

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

/* ============================================================
   Utilities
   ============================================================ */

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
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
    );
  } catch {
    return false;
  }
}
