import type {
  InjectionAssessment,
  InjectionRisk,
} from "@/src/schemas/guardrails";

type Rule = {
  category: string;
  risk: InjectionRisk;
  pattern: RegExp;
};

/**
 * Deterministic heuristics. Detection is diagnostic: it is reported to the
 * caller and to observability, and never rejects the support request. The
 * generation prompt independently treats customer text as untrusted.
 */
const RULES: readonly Rule[] = [
  {
    category: "instruction-override",
    risk: "high",
    pattern:
      /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|earlier|above|all)\b[^.]{0,20}\b(instruction|prompt|rule|direction)/i,
  },
  {
    category: "instruction-override",
    risk: "high",
    pattern:
      /\bfollow\b[^.]{0,30}\b(these|the following|my)\b[^.]{0,20}\b(new )?rules?\b[^.]{0,20}\binstead\b/i,
  },
  {
    category: "system-prompt-extraction",
    risk: "high",
    pattern:
      /\b(reveal|show|print|repeat|output|display|tell me)\b[^.]{0,40}\b(system prompt|hidden instruction|initial instruction|your instructions)/i,
  },
  {
    category: "secret-extraction",
    risk: "high",
    pattern:
      /\b(print|reveal|show|give me|what is)\b[^.]{0,30}\b(your )?(secrets?|api keys?|credentials?|tokens?)\b/i,
  },
  {
    category: "role-change",
    risk: "medium",
    pattern:
      /\b(you are now|act as|pretend to be|from now on you)\b|\bchange your role\b/i,
  },
  {
    category: "developer-impersonation",
    risk: "medium",
    pattern:
      /\b(i am|this is)\b[^.]{0,20}\b(the )?(developer|engineer|admin|administrator|your creator)\b/i,
  },
  {
    category: "guardrail-bypass",
    risk: "medium",
    pattern:
      /\b(developer|debug|god|dan)\s+mode\b|\bbypass\b[^.]{0,20}\b(policy|guardrails?|restrictions?)\b/i,
  },
  {
    category: "delimiter-injection",
    risk: "low",
    pattern: /<\/?(system|instructions?|customer_message)>|\[\/?(INST|SYSTEM)\]/i,
  },
];

const RISK_ORDER: Record<InjectionRisk, number> = { low: 0, medium: 1, high: 2 };

export function assessInjection(message: string): InjectionAssessment {
  const categories = new Set<string>();
  let risk: InjectionRisk = "low";

  for (const rule of RULES) {
    if (!rule.pattern.test(message)) continue;
    categories.add(rule.category);
    if (RISK_ORDER[rule.risk] > RISK_ORDER[risk]) risk = rule.risk;
  }

  return {
    detected: categories.size > 0,
    risk: categories.size > 0 ? risk : "low",
    categories: [...categories].sort(),
  };
}
