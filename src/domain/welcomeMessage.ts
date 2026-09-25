/**
 * Room 12 Approved Operator Welcome Message Template & Greeting Utilities.
 * 
 * Rules:
 * - Approved structure:
 *   "Hi, this is SEPT. I can help you with:
 *   • Finding and matching items across client requests and sourcers
 *   • Sourcing updates and price checks
 *   • Generating invoices and client offers
 *   • Tracking orders and deal status
 * 
 *   Important notes:
 *   1. I can only see and help with conversations I've been added to. Please add me to your sourcer groups and client chats.
 *   2. If anything goes wrong, text Yara with a screenshot of the issue.
 * 
 *   How can I help you?"
 * 
 * - If the first DM contains a real request (not just a greeting like 'hi', 'hello'),
 *   send the welcome message first, then handle the request in the same response or immediately after.
 */

export const OPERATOR_WELCOME_BASE = `Hi, this is SEPT.

I help you sell luxury — in the chats you already use.

I can:
* Remember pieces as they come in
* Match what’s available to the right clients
* Remember requests, sizes, prices, and open deals
* Track client shipments
* Draft messages in your voice, for your approval
* Prep invoices and payment summaries

I only see conversations I’m added to. Add me to the chats where you buy, sell, and talk to clients.`;

export const OPERATOR_WELCOME_PROMPT = `${OPERATOR_WELCOME_BASE}\n\nHow can I help?`;

/**
 * Operator Feedback Prompt (Product rule from Shrey):
 * - Sent strictly AFTER first useful action or day 2/3 check-in.
 * - Never sent on first touch, and never tied to an error.
 * - Delivered strictly once per operator (`feedback_prompt_sent`).
 */
export const OPERATOR_FEEDBACK_PROMPT = `Feedback for the team? Message Yara anytime.`;

const GREETING_REGEX = /^(hi|hello|hey|good\s+(morning|afternoon|evening)|hola|salaam|salam|sup|yo|greetings)[\s!.,?]*$/i;

/**
 * Checks if a message text is purely a greeting.
 */
export function isPureGreeting(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return GREETING_REGEX.test(trimmed);
}

/**
 * Formats the welcome reply.
 * If the user asked a real request, combines the welcome greeting with the request handling prompt.
 */
export function buildWelcomeReply(_operatorName: string, userText: string): { isGreeting: boolean; prompt: string; prefixText: string } {
  const greeting = isPureGreeting(userText);
  if (greeting) {
    return {
      isGreeting: true,
      prefixText: OPERATOR_WELCOME_PROMPT,
      prompt: OPERATOR_WELCOME_PROMPT,
    };
  }
  return {
    isGreeting: false,
    prefixText: OPERATOR_WELCOME_BASE,
    prompt: `${OPERATOR_WELCOME_BASE}\n\n---\nOperator Request:\n${userText}`,
  };
}
