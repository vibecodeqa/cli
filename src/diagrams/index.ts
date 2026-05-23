/** Architecture diagram generators — split by category for maintainability. */

export { buildCoverageMapInput, generateCoverageMap } from "./coverage.js";
export { generateArchSVG, generateDSM } from "./graph.js";
export { generateContainerDiagram, generateLayerDiagram, generatePackageDiagram, generateSequenceDiagram } from "./layers.js";
