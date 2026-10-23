import type { IncomingProposal } from "./proposals";

/** Everyday-language description of one approval request, shown on the approval card. */
export interface ProposalExplanation {
  doesWhat: string;
  saved: string;
  changes: string;
}

// Plain names for the things the assistant watches. Anything else gets a neutral phrase.
const AREA_NAMES: Record<string, string> = {
  inv_clean_test_suite: "your code's tests",
  inv_zero_broken_commits: "broken saves in your code",
  inv_bridge_connected: "the link between your phone and PC",
};

function areaOf(payload: Record<string, unknown> | undefined): string {
  const id = typeof payload?.invariantId === "string" ? payload.invariantId : "";
  return Object.hasOwn(AREA_NAMES, id) ? AREA_NAMES[id] : "something your assistant keeps an eye on";
}

export function explainProposal(p: IncomingProposal): ProposalExplanation {
  const needsCheck = p.requiresBiometric || p.riskLevel === "high";
  const checkNote = needsCheck
    ? " Your Yes is confirmed with your fingerprint or face, so nobody else can approve for you."
    : "";

  if (p.shadow) {
    return {
      doesWhat: "This is a practice question. It helps the assistant learn which suggestions are useful to you.",
      saved: `Your answer (Yes or No) and the time are saved on your PC.${checkNote}`,
      changes: "Nothing on your phone or PC changes, whichever you pick.",
    };
  }

  const payload = p.actionPayload;
  const command = typeof payload?.command === "string" ? payload.command : "";
  const area = areaOf(payload);

  if (command === "diagnostic_probe") {
    return {
      doesWhat: `It will look into ${area} to find out what is going on.`,
      saved: `What it finds is kept on your PC as a short report, along with your answer.${checkNote}`,
      changes: "It only looks. Nothing is changed.",
    };
  }

  if (command === "self_heal_restore") {
    return {
      doesWhat: `It will try to put ${area} back to how it is supposed to be.`,
      saved: `A record of what it did and your answer are saved on your PC.${checkNote}`,
      changes: "This can change settings or files on your PC. Say No if you are not sure.",
    };
  }

  return {
    doesWhat: "It will carry out the suggestion shown above.",
    saved: `Your answer and the time are saved on your PC.${checkNote}`,
    changes: "The exact changes are not listed here, so only say Yes if you recognise this.",
  };
}
