export interface CodeContextFile {
  path: string;
  language?: string;
  symbols?: string[];
  summary?: string;
}

export interface CodeContextGraph {
  root: string;
  files: CodeContextFile[];
  generatedAt: string;
}

export function createCodeContextGraph(root: string, files: CodeContextFile[] = []): CodeContextGraph {
  return { root, files, generatedAt: new Date().toISOString() };
}

export function queryCodeContext(graph: CodeContextGraph, query: string): CodeContextFile[] {
  const needle = query.toLowerCase();
  return graph.files.filter((file) => `${file.path} ${file.language ?? ""} ${(file.symbols ?? []).join(" ")} ${file.summary ?? ""}`.toLowerCase().includes(needle));
}
