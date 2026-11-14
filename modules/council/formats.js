// The Council formats: names, blurbs and seats for "Anonymous peer review", "Red team / blue team" and "Devil's advocate".
// The three-stage flow (answer alone, rank the others anonymised, a chairman writes the final answer) follows
// karpathy/llm-council backend/council.py; the prompts here are our own wording.

export const FORMATS = {
  decision: {
    id: 'decision', label: 'Decision', blurb: 'One seat argues for, one against, one weighs both. Best for build or buy, yes or no.',
    seats: [
      { id: 'builder', name: 'Builder', stance: 'argues for', brief: 'Argue for the proposal (doing it, building it, saying yes). Give the strongest honest case, with numbers when you can.' },
      { id: 'buyer', name: 'Buyer', stance: 'argues against', brief: 'Argue against the proposal (not doing it, buying instead, the alternative). Give the strongest honest case, with numbers when you can.' },
      { id: 'judge', name: 'Judge', stance: 'weighs both', brief: 'Weigh both sides and say which wins and under what condition. Be concrete.' },
    ],
  },
  experts: {
    id: 'experts', label: 'Three experts', blurb: 'Anonymous peer review: three independent experts answer, rank each other, and a chairman writes the answer.',
    seats: [
      { id: 'analyst', name: 'Analyst', stance: 'independent expert', brief: 'Answer as a careful analyst: facts, numbers, what is known and what is not.' },
      { id: 'practitioner', name: 'Practitioner', stance: 'independent expert', brief: 'Answer as someone who has done this many times: what works in practice, steps, pitfalls.' },
      { id: 'strategist', name: 'Strategist', stance: 'independent expert', brief: 'Answer as a strategist: the bigger picture, options, second-order effects.' },
    ],
  },
  devil: {
    id: 'devil', label: "Devil's advocate", blurb: 'One seat challenges every claim so soft agreement does not win by default.',
    seats: [
      { id: 'proposer', name: 'Proposer', stance: 'gives the best answer', brief: 'Give the best answer you can.' },
      { id: 'critic', name: 'Critic', stance: "devil's advocate", brief: 'Take the opposite view of the obvious answer and challenge its weakest assumptions.' },
      { id: 'referee', name: 'Referee', stance: 'weighs both', brief: 'Say where the obvious answer holds and where the challenge is right.' },
    ],
  },
};

export function guessFormat(question) {
  const q = String(question || '').toLowerCase();
  if (/\b(should (we|i)|shall (we|i)|is it worth|build or buy|or not|whether|versus|vs\.?|do we|would it be better)\b/.test(q) || /\bor\b.*\?$/.test(q)) return 'decision';
  return 'experts';
}
