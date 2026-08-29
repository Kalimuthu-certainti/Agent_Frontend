/** Gate vocabulary and verdicts — the single source, matching what the agent
 *  writes into the run log. */
export const GATE_ORDER = ['DoR', 'RG-TL', 'RG-Dev', 'RG-Test', 'RG-Ver', 'RG-Sec', 'G4'] as const;
export const CLEARING_VERDICTS = ['pass', 'approved'];

/** Gates that route to a human group for approval — every gate except the
 *  agent-run DoR check. */
export const ROUTABLE_GATES = GATE_ORDER.filter(g => g !== 'DoR');
