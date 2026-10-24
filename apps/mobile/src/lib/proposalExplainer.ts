import type { IncomingProposal } from "./proposals";

/** Everyday-language description of one approval request, shown on the approval card. */
export interface ProposalExplanation {
  /** One plain sentence naming the suggestion; replaces the internal summary as the card heading. */
  title: string;
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

function titleFor(command: string, area: string): string {
  if (command === "self_heal_restore") return `Fix ${area}`;
  if (command === "diagnostic_probe") return `Check on ${area}`;
  return "Your assistant has a suggestion";
}

export function explainProposal(p: IncomingProposal): ProposalExplanation {
  const needsCheck = p.requiresBiometric || p.riskLevel === "high";
  const checkNote = needsCheck
    ? " Your Yes is confirmed with your fingerprint or face, so nobody else can approve for you."
    : "";

  const payload = p.actionPayload;
  const command = typeof payload?.command === "string" ? payload.command : "";
  const area = areaOf(payload);

  if (p.shadow) {
    const idea =
      command === "self_heal_restore"
        ? `Your assistant noticed ${area} may be off, and wants to know if fixing it would be useful.`
        : command === "diagnostic_probe"
          ? `Your assistant wants to know if having it check on ${area} would be useful.`
          : "Your assistant has an idea and wants to know if it would be useful.";
    return {
      title: titleFor(command, area),
      doesWhat: `This is a practice question, so it does not do anything yet. ${idea} Your answer helps it learn what you want.`,
      saved: `Your answer (Yes or No) and the time are saved on your PC.${checkNote}`,
      changes: "Nothing on your phone or PC changes, whichever you pick.",
    };
  }

  if (command === "diagnostic_probe") {
    return {
      title: titleFor(command, area),
      doesWhat: `It will look into ${area} to find out what is going on.`,
      saved: `What it finds is kept on your PC as a short report, along with your answer.${checkNote}`,
      changes: "It only looks. Nothing is changed.",
    };
  }

  if (command === "self_heal_restore") {
    return {
      title: titleFor(command, area),
      doesWhat: `It will try to put ${area} back to how it is supposed to be.`,
      saved: `A record of what it did and your answer are saved on your PC.${checkNote}`,
      changes: "This can change settings or files on your PC. Say No if you are not sure.",
    };
  }

  return {
    title: titleFor(command, area),
    doesWhat: "It will carry out the suggestion in the heading above.",
    saved: `Your answer and the time are saved on your PC.${checkNote}`,
    changes: "The exact changes are not listed here, so only say Yes if you recognise this.",
  };
}
