/** The kit's `toolkit.d.ts` and `toolkit.json`, read from the toolkit's own source by the TypeScript compiler, so they can't drift from it: `pnpm agent:catalog` writes them and `toolkitDocs.test.ts` fails when the committed copies are stale or the declarations stop compiling. Node only (the compiler API); contract in docs/agent-kit.md ("The toolkit reference"). */

import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { TOOLKIT_SHOW } from "./toolkitShow";

const INDEX_PATH = fileURLToPath(new URL("../toolkit/index.ts", import.meta.url));
const TSCONFIG_PATH = fileURLToPath(new URL("../../tsconfig.json", import.meta.url));

const HEADER = `// Generated from the toolkit's source by pnpm agent:catalog. Do not edit.
// Scene files import from "@kookaburra/toolkit"; \`kb toolkit show <Name>\` reads the same source.
`;

const TYPE_TEXT =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
const LONG_TYPE = 1600;

export interface ToolkitProp {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  units?: string;
  doc?: string;
}

export interface ToolkitEntry {
  kind: "component" | "hook" | "function" | "constant" | "type";
  summary?: string;
  signature: string;
  doc?: string;
  props?: ToolkitProp[];
  /** A union's forms by name, when a component takes either shape. */
  example?: string;
  timing?: string[];
}

export interface ToolkitDocs {
  dts: string;
  entries: Record<string, ToolkitEntry>;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

function docOf(symbol: ts.Symbol, checker: ts.TypeChecker): string | undefined {
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker));
  return text ? flat(text) : undefined;
}

/** A default stated in the prop's own doc: "(default 0.8, clamped ...)", "default the theme's ...". */
function defaultFromDoc(doc: string | undefined): string | undefined {
  const hit = doc?.match(/\bdefault(?:s to)? ("[^"]*"|`[^`]*`|\[[^\]]*\]|[^;,)]+)/i);
  return hit?.[1]?.replace(/`/g, "").trim().replace(/\.$/, "");
}

const UNIT_PATTERNS: readonly [RegExp, string][] = [
  [/\bms\b|Ms$/, "ms"],
  [/\bem\b|Em$/, "em"],
  [/\bdegrees?\b|Deg$/, "degrees"],
  [/\bradians?\b|Rad$/, "radians"],
  [/\bworld(?:[- ]unit| units)/i, "world units"],
  [/\b0\.\.1\b/, "0..1"],
];

function unitsOf(name: string, doc: string | undefined): string | undefined {
  for (const [pattern, unit] of UNIT_PATTERNS) {
    if (pattern.test(name) || (doc && pattern.test(doc))) return unit;
  }
  return undefined;
}

/** Initialisers in the module's prop destructures (`{ from = 0 } = props` or a parameter pattern): a default the doc left unsaid. */
function destructureDefaults(source: ts.SourceFile): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isBindingElement(node) && node.initializer && !node.dotDotDotToken) {
      const name = flat((node.propertyName ?? node.name).getText(source));
      const value = flat(node.initializer.getText(source));
      if (!found.has(name) && value.length <= 40) found.set(name, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function propsOf(type: ts.Type, source: ts.SourceFile, checker: ts.TypeChecker): ToolkitProp[] {
  const defaults = destructureDefaults(source);
  const seen = new Set<string>();
  const out: ToolkitProp[] = [];
  const members = type.isUnion() ? type.types : [type];
  for (const member of members) {
    for (const prop of checker.getPropertiesOfType(member)) {
      if (seen.has(prop.name)) continue;
      seen.add(prop.name);
      const decl = prop.declarations?.[0];
      const declared =
        decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl))
          ? decl.type?.getText()
          : undefined;
      const doc = docOf(prop, checker);
      const required = (prop.flags & ts.SymbolFlags.Optional) === 0 && members.length === 1;
      const stated = defaultFromDoc(doc) ?? defaults.get(prop.name);
      out.push({
        name: prop.name,
        type: flat(
          declared ?? checker.typeToString(checker.getTypeOfSymbol(prop), undefined, TYPE_TEXT),
        ),
        required,
        ...(stated ? { default: stated } : {}),
        ...(unitsOf(prop.name, doc) ? { units: unitsOf(prop.name, doc) } : {}),
        ...(doc ? { doc } : {}),
      });
    }
  }
  return out;
}

interface Emitted {
  name: string;
  text: string;
  exported: boolean;
}

const stripDoc = (text: string) =>
  flat(text.replace(/\/\*\*[\s\S]*?\*\/\s*/g, "").replace(/(^|\s)export /g, "$1"));

class DtsBuilder {
  readonly emitted = new Map<ts.Symbol, Emitted>();
  readonly byName = new Map<string, ts.Symbol>();
  readonly externals = new Map<string, Set<string>>();
  readonly namespaces = new Map<string, string>();
  readonly queue: ts.Symbol[] = [];

  constructor(
    readonly checker: ts.TypeChecker,
    readonly program: ts.Program,
  ) {}

  /** The module a declaration in node_modules imports from. */
  private moduleOf(fileName: string): string | null {
    const at = fileName.lastIndexOf("/node_modules/");
    if (at < 0) return null;
    const path = fileName.slice(at + "/node_modules/".length);
    const parts = path.split("/");
    if (parts[0] === "@types") {
      const pkg = parts[1];
      if (pkg === "three" && parts[2] === "examples") {
        return `three/${parts
          .slice(2)
          .join("/")
          .replace(/\.d\.ts$/, ".js")}`;
      }
      return pkg;
    }
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  }

  private resolved(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  /** Files a referenced name: an external import, a lib global (nothing), or a local declaration to emit. */
  note(symbol: ts.Symbol | undefined, written: string): void {
    if (!symbol) return;
    const target = this.resolved(symbol);
    if (target.flags & ts.SymbolFlags.TypeParameter) return;
    const decl = target.declarations?.[0];
    if (!decl) return;
    const source = decl.getSourceFile();
    if (this.program.isSourceFileDefaultLibrary(source)) return;
    const external = this.moduleOf(source.fileName);
    if (external) {
      let names = this.externals.get(external);
      if (!names) {
        names = new Set();
        this.externals.set(external, names);
      }
      // JSX.Element prints as ReactElement, its plain name.
      names.add(external === "react" && written === "Element" ? "ReactElement" : written);
      return;
    }
    if (!this.emitted.has(target) && !this.queue.includes(target)) this.queue.push(target);
  }

  /** Every name a declaration's written types lean on. */
  private walk(node: ts.Node): void {
    const visit = (n: ts.Node) => {
      if (ts.isTypeReferenceNode(n)) {
        let root = n.typeName;
        if (ts.isQualifiedName(root)) {
          let left: ts.EntityName = root;
          while (ts.isQualifiedName(left)) left = left.left;
          const alias = this.checker.getSymbolAtLocation(left);
          const decl = alias?.declarations?.[0];
          if (decl && ts.isNamespaceImport(decl)) {
            const spec = (decl.parent.parent.moduleSpecifier as ts.StringLiteral).text;
            this.namespaces.set(left.text, spec);
          }
          root = left;
        } else {
          this.note(this.checker.getSymbolAtLocation(root), root.getText());
        }
      } else if (ts.isExpressionWithTypeArguments(n)) {
        this.note(this.checker.getSymbolAtLocation(n.expression), n.expression.getText());
      } else if (ts.isTypeQueryNode(n)) {
        if (ts.isIdentifier(n.exprName)) {
          this.note(this.checker.getSymbolAtLocation(n.exprName), n.exprName.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /** The names an inferred type leans on. */
  private walkType(type: ts.Type, depth = 0): void {
    if (depth > 6) return;
    const symbol = type.aliasSymbol ?? type.getSymbol();
    if (
      symbol &&
      !(symbol.flags & ts.SymbolFlags.TypeLiteral) &&
      !(symbol.flags & ts.SymbolFlags.ObjectLiteral)
    ) {
      const name = symbol.getName();
      if (name !== "__type" && name !== "__object" && name !== "__function")
        this.note(symbol, name);
    }
    for (const arg of type.aliasTypeArguments ?? []) this.walkType(arg, depth + 1);
    if (type.isUnionOrIntersection()) {
      for (const part of type.types) this.walkType(part, depth + 1);
    }
    const object = type as ts.TypeReference;
    if (object.target) {
      for (const arg of this.checker.getTypeArguments(object)) this.walkType(arg, depth + 1);
    }
    if (
      type.flags & ts.TypeFlags.Object &&
      !symbol?.declarations?.[0]?.getSourceFile().hasNoDefaultLib
    ) {
      for (const sig of type.getCallSignatures()) {
        this.walkType(sig.getReturnType(), depth + 1);
        for (const param of sig.getParameters()) {
          this.walkType(this.checker.getTypeOfSymbol(param), depth + 1);
        }
      }
    }
  }

  private typeText(type: ts.Type): string {
    this.walkType(type);
    return flat(this.checker.typeToString(type, undefined, TYPE_TEXT)).replace(
      /\b(?:(?:React\.)?JSX\.)?Element\b/g,
      "ReactElement",
    );
  }

  private functionText(name: string, node: ts.FunctionDeclaration): string {
    this.walk(node.typeParameters?.[0]?.parent ?? node);
    const generics = node.typeParameters?.length
      ? `<${node.typeParameters.map((p) => p.getText()).join(", ")}>`
      : "";
    const params = node.parameters
      .map((p, i) => {
        const label = ts.isIdentifier(p.name) ? p.name.text : i === 0 ? "props" : `arg${i}`;
        const optional = p.questionToken || p.initializer ? "?" : "";
        const dots = p.dotDotDotToken ? "..." : "";
        const type = p.type
          ? flat(p.type.getText())
          : this.typeText(this.checker.getTypeAtLocation(p));
        return `${dots}${label}${optional}: ${type}`;
      })
      .join(", ");
    const signature = this.checker.getSignatureFromDeclaration(node);
    const ret = node.type
      ? flat(node.type.getText())
      : signature
        ? this.typeText(signature.getReturnType())
        : "void";
    const usesElement = /\bReactElement\b/.test(ret);
    if (usesElement) this.noteElement();
    return `function ${name}${generics}(${params}): ${ret};`;
  }

  private noteElement(): void {
    let names = this.externals.get("react");
    if (!names) {
      names = new Set();
      this.externals.set("react", names);
    }
    names.add("ReactElement");
  }

  /** Declaration text with its doc comment, unexported. */
  private declarationText(symbol: ts.Symbol, name: string, exported: boolean): string {
    const parts: string[] = [];
    for (const decl of symbol.declarations ?? []) {
      const docs = ts.getJSDocCommentsAndTags(decl).filter(ts.isJSDoc);
      const doc = docs.at(-1)?.getText();
      let body: string;
      if (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) {
        this.walk(decl);
        body = decl.getText().replace(/^export\s+(default\s+)?/, "");
      } else if (ts.isEnumDeclaration(decl)) {
        body = decl.getText().replace(/^export\s+/, "");
      } else if (ts.isFunctionDeclaration(decl)) {
        if (!decl.body && (symbol.declarations?.length ?? 0) > 1) continue;
        body = this.functionText(name, decl);
      } else if (ts.isVariableDeclaration(decl)) {
        const type = decl.type
          ? flat(decl.type.getText())
          : this.typeText(this.checker.getTypeOfSymbol(symbol));
        if (decl.type) this.walk(decl.type);
        const stated = type.length > LONG_TYPE ? "unknown" : type;
        body = `const ${name}: ${stated};`;
      } else if (ts.isClassDeclaration(decl)) {
        body = `class ${name} {}`;
      } else {
        continue;
      }
      const stated = `${exported ? "export " : ""}${body}`;
      parts.push(doc ? `${doc}\n${stated}` : stated);
    }
    return parts.join("\n");
  }

  add(symbol: ts.Symbol, name: string, exported: boolean): void {
    if (this.emitted.has(symbol)) return;
    const clash = this.byName.get(name);
    if (clash && clash !== symbol) {
      // A private copy of the same shape in another module is the same declaration here.
      const mine = stripDoc(this.declarationText(symbol, name, false));
      const theirs = stripDoc(this.emitted.get(clash)?.text ?? "");
      if (mine !== theirs) {
        throw new Error(
          `toolkit.d.ts: two different declarations named ${name}:\n${theirs}\n${mine}`,
        );
      }
      this.emitted.set(symbol, { name, text: "", exported: false });
      return;
    }
    this.byName.set(name, symbol);
    const placeholder: Emitted = { name, text: "", exported };
    this.emitted.set(symbol, placeholder);
    placeholder.text = this.declarationText(symbol, name, exported);
  }

  drain(): void {
    while (this.queue.length > 0) {
      const symbol = this.queue.shift() as ts.Symbol;
      this.add(symbol, symbol.getName(), false);
    }
  }

  print(): string {
    const rows = [...this.emitted.values()]
      .filter((e) => e.text)
      .sort((a, b) => {
        if (a.exported !== b.exported) return a.exported ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    const imports = [...this.externals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([module, names]) => {
        const list = [...names].sort().join(", ");
        return `  import type { ${list} } from "${module}";`;
      });
    const namespaces = [...this.namespaces.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, module]) => `  import type * as ${name} from "${module}";`);
    const body = rows.map((row) =>
      row.text
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    return `${HEADER}declare module "@kookaburra/toolkit" {\n${[...imports, ...namespaces].join("\n")}\n\n${body.join("\n\n")}\n\n  export {};\n}\n`;
  }
}

function program(): ts.Program {
  const read = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    TSCONFIG_PATH.replace(/\/tsconfig\.json$/, ""),
  ).options;
  return ts.createProgram([INDEX_PATH], { ...options, noEmit: true });
}

const KIND_OF_FLAGS = (name: string, decl: ts.Declaration): ToolkitEntry["kind"] => {
  if (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) return "type";
  if (ts.isEnumDeclaration(decl)) return "type";
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer;
    if (!init || !(ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return "constant";
  }
  if (/^use[A-Z]/.test(name)) return "hook";
  return /^[A-Z]/.test(name) ? "component" : "function";
};

/** A component's fallback example: every required prop, with a placeholder of its type. */
function autoExample(name: string, props: readonly ToolkitProp[]): string {
  const attrs = props
    .filter((p) => p.required && p.name !== "children")
    .map((p) => {
      if (p.type === "string" || /^"/.test(p.type)) return `${p.name}="..."`;
      if (p.type === "number") return `${p.name}={1}`;
      return `${p.name}={...}`;
    });
  return `<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""} />`;
}

export function buildToolkitDocs(
  summaries: Readonly<Record<string, { summary: string; internal?: boolean }>>,
): ToolkitDocs {
  const prog = program();
  const checker = prog.getTypeChecker();
  const index = prog.getSourceFile(INDEX_PATH);
  if (!index) throw new Error("toolkit index not found");
  const moduleSymbol = checker.getSymbolAtLocation(index);
  if (!moduleSymbol) throw new Error("toolkit index is not a module");
  const builder = new DtsBuilder(checker, prog);
  const entries: Record<string, ToolkitEntry> = {};

  const exports = [...checker.getExportsOfModule(moduleSymbol)].sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const exported of exports) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const decl = symbol.declarations?.[0];
    if (!decl) continue;
    if (summaries[exported.name]?.internal) continue;
    builder.add(symbol, exported.name, true);
    const emitted = builder.emitted.get(symbol);
    const kind = KIND_OF_FLAGS(exported.name, decl);
    const show = TOOLKIT_SHOW[exported.name];
    const entry: ToolkitEntry = {
      kind,
      ...(summaries[exported.name]?.summary ? { summary: summaries[exported.name].summary } : {}),
      signature: stripDoc(emitted?.text ?? ""),
      ...(docOf(symbol, checker) ? { doc: docOf(symbol, checker) } : {}),
    };
    if (kind === "component" && ts.isFunctionDeclaration(decl) && decl.parameters[0]) {
      const type = checker.getTypeAtLocation(decl.parameters[0]);
      const props = propsOf(type, decl.getSourceFile(), checker);
      if (props.length > 0) entry.props = props;
      entry.example = show?.example ?? autoExample(exported.name, props);
    } else if (show?.example) {
      entry.example = show.example;
    }
    if (show?.timing) entry.timing = [...show.timing];
    entries[exported.name] = entry;
  }
  // Only now: an export something else names must be emitted as an export, not a private helper.
  builder.drain();
  return { dts: builder.print(), entries };
}

/** The compile errors in generated declarations, as text; empty when they stand alone. */
export function dtsErrors(dtsPath: string): string[] {
  const read = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    TSCONFIG_PATH.replace(/\/tsconfig\.json$/, ""),
  ).options;
  const prog = ts.createProgram([dtsPath], {
    ...options,
    noEmit: true,
    skipLibCheck: false,
    noUnusedLocals: false,
    types: [],
  });
  const file = prog.getSourceFile(dtsPath);
  if (!file) return [`${dtsPath} did not load`];
  return ts.getPreEmitDiagnostics(prog, file).map((d) => {
    const line =
      d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    return `${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
}

/** The tags and attributes of an example, so a test can hold it to the real props. */
export function exampleUses(example: string): { tag: string; attrs: string[] }[] {
  const source = ts.createSourceFile(
    "example.tsx",
    example,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const uses: { tag: string; attrs: string[] }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      uses.push({
        tag: node.tagName.getText(source),
        attrs: node.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((a) => a.name.getText(source)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}
