import ts from 'typescript'
import type { StaticMetadataTreeNode } from '../shared/message-types.js'

export interface SdkTypeTreeOptions {
  source: string
  maxDepth?: number
  maxProperties?: number
  maxUnionVariants?: number
}

type BuildContext = {
  checker: ts.TypeChecker
  sourceFile: ts.SourceFile
  sourcePath: string
  options: Required<SdkTypeTreeOptions>
}

type NodeInput = {
  key: string
  path: string
  label?: string
  kind: StaticMetadataTreeNode['kind']
  status?: StaticMetadataTreeNode['status']
  description?: string
  source?: string
  value?: unknown
  requiresSession?: boolean
  children?: StaticMetadataTreeNode[]
  meta?: Record<string, unknown>
}

function createNode(input: NodeInput): StaticMetadataTreeNode {
  return {
    key: input.key,
    path: input.path,
    label: input.label ?? input.key,
    kind: input.kind,
    status: input.status ?? 'unavailable',
    ...(input.description ? { description: input.description } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.requiresSession ? { requiresSession: true } : {}),
    ...(input.children ? { children: input.children } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  }
}

function toLabel(key: string): string {
  if (!key) return key
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (char) => char.toUpperCase())
}

function getKeyFromPath(path: string): string {
  if (path.endsWith('[]')) return 'item'
  if (path.includes('.')) return path.split('.').pop() || path
  return path
}

function getDescription(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): string | undefined {
  if (!symbol) return undefined
  const text = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
  return text || undefined
}

function isUndefinedType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Undefined) !== 0
}

function isNullType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Null) !== 0
}

function removeUndefinedFromType(type: ts.Type, _checker: ts.TypeChecker): ts.Type {
  if (!type.isUnion()) return type
  const filtered = type.types.filter((part) => !isUndefinedType(part))
  if (filtered.length === 1) return filtered[0]!
  if (filtered.length === type.types.length || filtered.length === 0) return type
  return type
}

function literalValue(type: ts.Type, checker?: ts.TypeChecker): string | number | boolean | null | undefined {
  if (type.isStringLiteral()) return type.value
  if (type.isNumberLiteral()) return type.value
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    return checker ? checker.typeToString(type) === 'true' : undefined
  }
  if (isNullType(type)) return null
  if (isUndefinedType(type)) return undefined
  return undefined
}

function primitiveKind(type: ts.Type): StaticMetadataTreeNode['kind'] | null {
  if (type.isStringLiteral() || (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLike)) !== 0) return 'string'
  if (type.isNumberLiteral() || (type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLike)) !== 0) return 'number'
  if ((type.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLike | ts.TypeFlags.BooleanLiteral)) !== 0) return 'boolean'
  if (isNullType(type)) return 'null'
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return 'unknown'
  return null
}

function sanitizeVariantLabel(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  return cleaned || fallback
}

function buildPrimitiveNode(path: string, type: ts.Type, ctx: BuildContext, symbol?: ts.Symbol, meta?: Record<string, unknown>): StaticMetadataTreeNode {
  const key = getKeyFromPath(path)
  const literal = literalValue(type, ctx.checker)
  return createNode({
    key,
    path,
    label: toLabel(key),
    kind: primitiveKind(type) ?? 'unknown',
    source: ctx.options.source,
    description: getDescription(symbol, ctx.checker),
    meta: {
      typeRef: ctx.checker.typeToString(type),
      ...(literal !== undefined ? { literal } : {}),
      ...(meta ?? {}),
    },
  })
}

function buildArrayNode(path: string, type: ts.Type, ctx: BuildContext, depth: number, symbol?: ts.Symbol, meta?: Record<string, unknown>): StaticMetadataTreeNode {
  const key = getKeyFromPath(path)
  if (depth >= ctx.options.maxDepth) {
    return createNode({
      key,
      path,
      label: toLabel(key),
      kind: 'array',
      source: ctx.options.source,
      description: getDescription(symbol, ctx.checker),
      meta: { typeRef: ctx.checker.typeToString(type), maxDepthHit: true, ...(meta ?? {}) },
    })
  }

  if (ctx.checker.isTupleType(type)) {
    const tuple = type as ts.TupleType
    const typeArgs = ctx.checker.getTypeArguments(tuple)
    const children = typeArgs.slice(0, ctx.options.maxProperties).map((part, index) =>
      buildTypeNode(`${path}[${index}]`, part, ctx, depth + 1, undefined)
    )
    return createNode({
      key,
      path,
      label: toLabel(key),
      kind: 'array',
      source: ctx.options.source,
      description: getDescription(symbol, ctx.checker),
      children,
      meta: {
        typeRef: ctx.checker.typeToString(type),
        tuple: true,
        length: typeArgs.length,
        ...(typeArgs.length > ctx.options.maxProperties ? { truncated: true } : {}),
        ...(meta ?? {}),
      },
    })
  }

  const typeReference = type as ts.TypeReference
  const typeArgs = typeof typeReference.target !== 'undefined'
    ? ctx.checker.getTypeArguments(typeReference)
    : []
  const children = typeArgs.length > 0
    ? [buildTypeNode(`${path}[]`, typeArgs[0]!, ctx, depth + 1, undefined)]
    : undefined

  return createNode({
    key,
    path,
    label: toLabel(key),
    kind: 'array',
    source: ctx.options.source,
    description: getDescription(symbol, ctx.checker),
    children,
    meta: {
      typeRef: ctx.checker.typeToString(type),
      ...(meta ?? {}),
    },
  })
}

function buildUnionNode(path: string, type: ts.UnionType, ctx: BuildContext, depth: number, symbol?: ts.Symbol, meta?: Record<string, unknown>): StaticMetadataTreeNode {
  const key = getKeyFromPath(path)
  const variants = type.types.map((part) => ctx.checker.typeToString(part))
  const literals = type.types
    .map((part) => literalValue(part, ctx.checker))
    .filter((value): value is string | number | boolean | null => value !== undefined)

  const nodeMeta: Record<string, unknown> = {
    typeRef: ctx.checker.typeToString(type),
    variants,
    ...(meta ?? {}),
  }
  if (literals.length === type.types.length) {
    nodeMeta.enum = literals
  }

  if (depth >= ctx.options.maxDepth || type.types.length > ctx.options.maxUnionVariants) {
    if (type.types.length > ctx.options.maxUnionVariants) {
      nodeMeta.truncated = true
    }
    if (depth >= ctx.options.maxDepth) {
      nodeMeta.maxDepthHit = true
    }
    return createNode({
      key,
      path,
      label: toLabel(key),
      kind: 'union',
      source: ctx.options.source,
      description: getDescription(symbol, ctx.checker),
      meta: nodeMeta,
    })
  }

  const children = type.types.map((part, index) => {
    const label = sanitizeVariantLabel(ctx.checker.typeToString(part), `variant ${index + 1}`)
    const childPath = `${path}.variant${index + 1}`
    const child = buildTypeNode(childPath, part, ctx, depth + 1, undefined)
    return {
      ...child,
      label,
      meta: {
        ...(child.meta ?? {}),
        variantOf: path,
      },
    }
  })

  return createNode({
    key,
    path,
    label: toLabel(key),
    kind: 'union',
    source: ctx.options.source,
    description: getDescription(symbol, ctx.checker),
    children,
    meta: nodeMeta,
  })
}

function buildObjectNode(path: string, type: ts.Type, ctx: BuildContext, depth: number, symbol?: ts.Symbol, meta?: Record<string, unknown>): StaticMetadataTreeNode {
  const key = getKeyFromPath(path)
  const typeText = ctx.checker.typeToString(type)
  const props = ctx.checker.getPropertiesOfType(type)
  const stringIndex = ctx.checker.getIndexTypeOfType(type, ts.IndexKind.String)
  const numberIndex = ctx.checker.getIndexTypeOfType(type, ts.IndexKind.Number)

  const nodeMeta: Record<string, unknown> = {
    typeRef: typeText,
    ...(meta ?? {}),
  }

  if (stringIndex) {
    nodeMeta.additionalProperties = ctx.checker.typeToString(stringIndex)
  }
  if (numberIndex) {
    nodeMeta.numericIndex = ctx.checker.typeToString(numberIndex)
  }

  if (depth >= ctx.options.maxDepth) {
    nodeMeta.maxDepthHit = true
    return createNode({
      key,
      path,
      label: toLabel(key),
      kind: 'object',
      source: ctx.options.source,
      description: getDescription(symbol, ctx.checker),
      meta: nodeMeta,
    })
  }

  const declarations = symbol?.declarations ?? type.symbol?.declarations ?? []
  const hasExternalDeclaration = declarations.some((declaration) => declaration.getSourceFile().fileName !== ctx.sourcePath)
  if (props.length === 0 && !stringIndex && !numberIndex && hasExternalDeclaration) {
    return createNode({
      key,
      path,
      label: toLabel(key),
      kind: 'unknown',
      source: ctx.options.source,
      description: getDescription(symbol, ctx.checker),
      meta: {
        ...nodeMeta,
        opaque: true,
      },
    })
  }

  const limitedProps = props.slice(0, ctx.options.maxProperties)
  const children = limitedProps.map((prop) => {
    const declaration = prop.valueDeclaration ?? prop.declarations?.[0] ?? ctx.sourceFile
    const optional = (prop.getFlags() & ts.SymbolFlags.Optional) !== 0
    const propType = optional
      ? removeUndefinedFromType(ctx.checker.getTypeOfSymbolAtLocation(prop, declaration), ctx.checker)
      : ctx.checker.getTypeOfSymbolAtLocation(prop, declaration)
    const child = buildTypeNode(`${path}.${prop.getName()}`, propType, ctx, depth + 1, prop, { optional })
    return child
  })

  if (props.length > ctx.options.maxProperties) {
    nodeMeta.truncated = true
    nodeMeta.totalProperties = props.length
  }

  return createNode({
    key,
    path,
    label: toLabel(key),
    kind: 'object',
    source: ctx.options.source,
    description: getDescription(symbol, ctx.checker),
    children,
    meta: nodeMeta,
  })
}

function buildTypeNode(path: string, type: ts.Type, ctx: BuildContext, depth: number, symbol?: ts.Symbol, meta?: Record<string, unknown>): StaticMetadataTreeNode {
  const primitive = primitiveKind(type)
  if (primitive) {
    return buildPrimitiveNode(path, type, ctx, symbol, meta)
  }

  if (type.isUnion()) {
    return buildUnionNode(path, type, ctx, depth, symbol, meta)
  }

  if (ctx.checker.isArrayType(type) || ctx.checker.isTupleType(type)) {
    return buildArrayNode(path, type, ctx, depth, symbol, meta)
  }

  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    return buildObjectNode(path, type, ctx, depth, symbol, meta)
  }

  return createNode({
    key: getKeyFromPath(path),
    path,
    label: toLabel(getKeyFromPath(path)),
    kind: 'unknown',
    source: ctx.options.source,
    description: getDescription(symbol, ctx.checker),
    meta: {
      typeRef: ctx.checker.typeToString(type),
      ...(meta ?? {}),
    },
  })
}

export function buildSdkExportTree(sdkDtsPath: string, exportName: string, path: string, options: SdkTypeTreeOptions): StaticMetadataTreeNode {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    strict: true,
    esModuleInterop: true,
  }
  const program = ts.createProgram([sdkDtsPath], compilerOptions)
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(sdkDtsPath)
  if (!sourceFile) {
    throw new Error(`SDK declaration file not found: ${sdkDtsPath}`)
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) {
    throw new Error(`Unable to read module symbol from: ${sdkDtsPath}`)
  }

  const symbol = checker.getExportsOfModule(moduleSymbol).find((entry) => entry.getName() === exportName)
  if (!symbol) {
    throw new Error(`Export not found in sdk.d.ts: ${exportName}`)
  }

  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? sourceFile
  const rawType = checker.getDeclaredTypeOfSymbol(symbol)
  const type = removeUndefinedFromType(rawType, checker)
  const ctx: BuildContext = {
    checker,
    sourceFile,
    sourcePath: sdkDtsPath,
    options: {
      source: options.source,
      maxDepth: options.maxDepth ?? 3,
      maxProperties: options.maxProperties ?? 40,
      maxUnionVariants: options.maxUnionVariants ?? 8,
    },
  }

  const node = buildTypeNode(path, type, ctx, 0, symbol, {
    exportedType: exportName,
    declarationKind: ts.SyntaxKind[declaration.kind],
  })

  return {
    ...node,
    key: getKeyFromPath(path),
    path,
    label: toLabel(getKeyFromPath(path)),
  }
}

export function mapTree(node: StaticMetadataTreeNode, mapper: (node: StaticMetadataTreeNode) => StaticMetadataTreeNode): StaticMetadataTreeNode {
  const mappedChildren = node.children?.map((child) => mapTree(child, mapper))
  return mapper({
    ...node,
    ...(mappedChildren ? { children: mappedChildren } : {}),
  })
}

export function overlayNodeValues(node: StaticMetadataTreeNode, value: unknown, source: string): StaticMetadataTreeNode {
  if (value === undefined) return node

  if (Array.isArray(value)) {
    return {
      ...node,
      status: 'resolved',
      value,
      source,
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const existingChildren = node.children ?? []
    const childrenByKey = new Map(existingChildren.map((child) => [child.key, child]))
    const mergedChildren = existingChildren.map((child) => overlayNodeValues(child, record[child.key], source))
    for (const [key, entry] of Object.entries(record)) {
      if (childrenByKey.has(key)) continue
      mergedChildren.push(createNode({
        key,
        path: `${node.path}.${key}`,
        label: toLabel(key),
        kind: Array.isArray(entry) ? 'array' : entry === null ? 'null' : typeof entry === 'string' ? 'string' : typeof entry === 'number' ? 'number' : typeof entry === 'boolean' ? 'boolean' : 'object',
        source,
        status: 'resolved',
        value: entry,
      }))
    }
    return {
      ...node,
      status: 'resolved',
      value,
      source,
      children: mergedChildren,
    }
  }

  return {
    ...node,
    status: 'resolved',
    value,
    source,
  }
}
