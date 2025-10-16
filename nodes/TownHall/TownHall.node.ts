import axios, { AxiosError } from 'axios';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  IDataObject,
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
  GenericValue,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

type ActionType = 'location' | 'project-maturity';

/** --------------------
 *  SCHEMA (action optionnelle + extraFields corrigé)
 *  -------------------- */
const projectApiInputSchema = z.object({
  action: z
    .enum(['location', 'project-maturity'] as const)
    .describe(
      'Operation to perform: "location" sends address data, "project-maturity" sends maturity data.',
    )
    .optional(),
  sessionId: z.string().describe('Optional session identifier.').optional(),

  // LOCATION (souple)
  address: z.string().describe('Single address.').optional(),
  addresses: z
    .array(
      z.union([
        z.string().describe('Address text'),
        z.object({
          address: z.string().describe('Full address text.'),
          price: z.union([z.number(), z.string()]).optional(),
          surface: z.string().optional(),
          locationType: z.string().optional(),
        }),
      ]),
    )
    .describe('Array of locations. Strings or objects are accepted.')
    .optional(),
  price: z.union([z.number(), z.string()]).optional(),
  surface: z.string().optional(),
  locationType: z.string().optional(),

  // MATURITY (souple)
  maturityLevel: z.string().optional(),
  maturityPercentage: z.union([z.number(), z.string()]).optional(),
  positivePoints: z.array(z.string()).optional(),
  negativePoints: z.array(z.string()).optional(),
  description: z.string().optional(),

  // Champs additionnels libres (pass-through)
  extraFields: z.record(z.string(), z.unknown()).optional(),
});

export type ProjectApiToolInput = z.infer<typeof projectApiInputSchema>;

interface NormalizedAddress {
  address: string;
  price?: number;
  surface?: string;
  locationType?: string;
}

interface NormalizedLocationBody {
  sessionId?: string;
  address?: string;
  price?: number;
  surface?: string;
  locationType?: string;
  addresses: NormalizedAddress[];
  // champs supplémentaires éventuels
  [k: string]: unknown;
}

interface NormalizedMaturityBody {
  sessionId?: string;
  maturityLevel?: string;
  maturityPercentage?: number;
  positivePoints?: string[];
  negativePoints?: string[];
  description?: string;
  // champs supplémentaires éventuels
  [k: string]: unknown;
}

type NormalizedRequest =
  | { action: 'location'; body: NormalizedLocationBody }
  | { action: 'project-maturity'; body: NormalizedMaturityBody };

interface ToolExecutionResult extends IDataObject {
  status: 'success' | 'validation_error' | 'error';
  action: ActionType;
  requestBody?: GenericValue;
  response?: GenericValue;
  validationWarnings?: string[];
  validationErrors?: string[];
  error?: IDataObject;
}

interface ProjectApiToolOptions {
  context: ISupplyDataFunctions;
  baseUrl: string;
  manualDefaults: Partial<ProjectApiToolInput>;
  name?: string;
  description?: string;
}

export class ProjectApiTool extends DynamicStructuredTool<typeof projectApiInputSchema> {
  constructor(options: ProjectApiToolOptions) {
    super({
      name: options.name ?? 'project_api_tool',
      description:
        options.description ??
        'Send structured location or project maturity data to the Project Buddy API. The AI can provide all parameters dynamically, and they will be merged with any pre-configured defaults.',
      schema: projectApiInputSchema,
      func: async (input: unknown) => {
        const parsed = projectApiInputSchema.parse(input);
        return JSON.stringify(
          await handleProjectApiRequest({
            toolInput: parsed,
            baseUrl: options.baseUrl,
            manualDefaults: options.manualDefaults,
            context: options.context,
          }),
        );
      },
    });
  }
}

/** --------------------
 *  UTILS
 *  -------------------- */
function resolveBaseUrl(context: ISupplyDataFunctions, sessionInfo: IDataObject): string {
  const candidateFromUi =
    typeof sessionInfo.apiBaseUrl === 'string' ? sessionInfo.apiBaseUrl.trim() : '';

  const envCandidates = [
    process.env.PROJECT_BUDDY_API_BASE_URL,
    process.env.PROJECT_BUDDY_BASE_URL,
    process.env.PROJECT_API_BASE_URL,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  const baseUrl = candidateFromUi || envCandidates[0] || '';

  if (!baseUrl) {
    throw new NodeOperationError(
      context.getNode(),
      'Project Buddy API base URL is not configured. Provide Session Info → API Base URL or set the PROJECT_BUDDY_API_BASE_URL environment variable.',
      { itemIndex: 0 },
    );
  }
  return baseUrl.replace(/\/$/, '');
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function dedupeStrings(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const cleaned = values
    .map((v) => sanitizeString(v))
    .filter((s): s is string => typeof s === 'string');
  return cleaned.length ? Array.from(new Set(cleaned)) : undefined;
}

/** fixedCollection → strings */
function dedupePointsFromFixedCollection(
  entries: IDataObject[] | IDataObject | undefined,
): string[] | undefined {
  if (!entries) return undefined;

  const arrayEntries = Array.isArray(entries)
    ? entries
    : Array.isArray((entries as IDataObject).values)
    ? ((entries as IDataObject).values as IDataObject[])
    : [];

  if (!arrayEntries.length) return undefined;

  return dedupeStrings(arrayEntries.map((e) => e.text));
}

/** addresses: accepte string[] ou object[] ou fixedCollection */
function normalizeAddresses(raw: unknown): NormalizedAddress[] | undefined {
  // fixedCollection support
  const maybeArray =
    Array.isArray(raw)
      ? raw
      : Array.isArray((raw as IDataObject)?.values)
      ? ((raw as IDataObject).values as IDataObject[])
      : [];

  const normalized = maybeArray
    .map((entry) => {
      if (typeof entry === 'string') {
        const addr = sanitizeString(entry);
        return addr ? ({ address: addr } as NormalizedAddress) : null;
      }
      const address = sanitizeString((entry as IDataObject).address);
      if (!address) return null;

      const price = toNumber((entry as IDataObject).price);
      const surface = sanitizeString((entry as IDataObject).surface);
      const locationType = sanitizeString((entry as IDataObject).locationType);

      const payload: NormalizedAddress = { address };
      if (price !== undefined) payload.price = price;
      if (surface) payload.surface = surface;
      if (locationType) payload.locationType = locationType;
      return payload;
    })
    .filter((e): e is NormalizedAddress => e !== null);

  return normalized.length ? normalized : undefined;
}

/** Déterminer automatiquement l’action si manquante */
function inferActionFromFields(input: ProjectApiToolInput, fallback?: ActionType): {
  action: ActionType | undefined;
  warning?: string;
} {
  const hasLocationSignal =
    !!sanitizeString(input.address) ||
    !!normalizeAddresses(input.addresses)?.length ||
    toNumber(input.price) !== undefined ||
    !!sanitizeString(input.surface) ||
    !!sanitizeString(input.locationType);

  const hasMaturitySignal =
    !!sanitizeString(input.maturityLevel) ||
    toNumber(input.maturityPercentage) !== undefined ||
    !!dedupeStrings(input.positivePoints)?.length ||
    !!dedupeStrings(input.negativePoints)?.length ||
    !!sanitizeString(input.description);

  if (hasLocationSignal && !hasMaturitySignal) return { action: 'location' };
  if (!hasLocationSignal && hasMaturitySignal) return { action: 'project-maturity' };
  if (hasLocationSignal && hasMaturitySignal) {
    // heuristique simple : prioriser le plus d’indicateurs
    const scoreLoc =
      (normalizeAddresses(input.addresses)?.length ? 1 : 0) +
      (sanitizeString(input.address) ? 1 : 0) +
      (toNumber(input.price) !== undefined ? 1 : 0) +
      (sanitizeString(input.surface) ? 1 : 0) +
      (sanitizeString(input.locationType) ? 1 : 0);
    const scoreMat =
      (sanitizeString(input.maturityLevel) ? 1 : 0) +
      (toNumber(input.maturityPercentage) !== undefined ? 1 : 0) +
      (dedupeStrings(input.positivePoints)?.length ? 1 : 0) +
      (dedupeStrings(input.negativePoints)?.length ? 1 : 0) +
      (sanitizeString(input.description) ? 1 : 0);

    if (scoreLoc > scoreMat) return { action: 'location', warning: 'Both families detected. Chose "location".' };
    if (scoreMat > scoreLoc) return { action: 'project-maturity', warning: 'Both families detected. Chose "project-maturity".' };
    return { action: fallback, warning: 'Both families detected. Fell back to node default action.' };
  }
  return { action: fallback };
}

function mergeManualAndStructuredInput(
  manualDefaults: Partial<ProjectApiToolInput>,
  toolInput?: ProjectApiToolInput | null,
): ProjectApiToolInput {
  const structured = (toolInput ?? {}) as Partial<ProjectApiToolInput>;
  const merged: ProjectApiToolInput = {
    // action pourra être ajouté après inférence
    action: structured.action ?? manualDefaults.action,
    sessionId: structured.sessionId ?? manualDefaults.sessionId,

    // location
    address: structured.address ?? manualDefaults.address,
    addresses: structured.addresses ?? manualDefaults.addresses,
    price: structured.price ?? manualDefaults.price,
    surface: structured.surface ?? manualDefaults.surface,
    locationType: structured.locationType ?? manualDefaults.locationType,

    // maturity
    maturityLevel: structured.maturityLevel ?? manualDefaults.maturityLevel,
    maturityPercentage: structured.maturityPercentage ?? manualDefaults.maturityPercentage,
    positivePoints:
      structured.positivePoints?.length || manualDefaults.positivePoints?.length
        ? Array.from(new Set([...(manualDefaults.positivePoints ?? []), ...(structured.positivePoints ?? [])]))
        : undefined,
    negativePoints:
      structured.negativePoints?.length || manualDefaults.negativePoints?.length
        ? Array.from(new Set([...(manualDefaults.negativePoints ?? []), ...(structured.negativePoints ?? [])]))
        : undefined,
    description: structured.description ?? manualDefaults.description,

    // champs supplémentaires
    extraFields: { ...(manualDefaults.extraFields ?? {}), ...(structured.extraFields ?? {}) },
  };
  return merged;
}

function normalizeInput(
  input: ProjectApiToolInput,
  nodeDefaultAction?: ActionType,
): { request: NormalizedRequest | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let sessionId = sanitizeString(input.sessionId);
  if (input.sessionId && !sessionId) {
    warnings.push('Provided sessionId is blank after trimming and was ignored.');
    sessionId = undefined;
  }

  // Inférer l’action si manquante
  let action = input.action as ActionType | undefined;
  if (!action) {
    const inferred = inferActionFromFields(input, nodeDefaultAction);
    action = inferred.action;
    if (inferred.warning) warnings.push(inferred.warning);
  }
  if (!action) {
    errors.push('Action is required or must be inferable from the provided fields.');
    return { errors, warnings, request: null };
  }

  if (action === 'location') {
    const singleAddress = sanitizeString(input.address);
    const arr = normalizeAddresses(input.addresses);

    let normalizedAddresses: NormalizedAddress[] = arr ? [...arr] : [];
    if (!normalizedAddresses.length && singleAddress) {
      normalizedAddresses.push({
        address: singleAddress,
        price: toNumber(input.price),
        surface: sanitizeString(input.surface),
        locationType: sanitizeString(input.locationType),
      });
    } else if (normalizedAddresses.length && singleAddress) {
      warnings.push('Both "address" and "addresses" were provided. Prioritizing the array payload.');
    }

    normalizedAddresses = normalizedAddresses.filter((e) => e.address.length);
    if (!normalizedAddresses.length) {
      errors.push('At least one valid address is required for the "location" action.');
    }

    const price = normalizedAddresses.length === 1
      ? normalizedAddresses[0].price ?? toNumber(input.price)
      : toNumber(input.price);

    const surface = normalizedAddresses.length === 1
      ? normalizedAddresses[0].surface ?? sanitizeString(input.surface)
      : sanitizeString(input.surface);

    const locationType = normalizedAddresses.length === 1
      ? normalizedAddresses[0].locationType ?? sanitizeString(input.locationType)
      : sanitizeString(input.locationType);

    const body: NormalizedLocationBody = {
      sessionId,
      address: singleAddress ?? normalizedAddresses[0]?.address,
      price,
      surface,
      locationType,
      addresses: normalizedAddresses,
      ...(input.extraFields ?? {}),
    };

    return { request: { action: 'location', body }, errors, warnings };
  }

  if (action === 'project-maturity') {
    const maturityLevel = sanitizeString(input.maturityLevel);
    const maturityPercentage = toNumber(input.maturityPercentage);
    if (maturityPercentage !== undefined && (maturityPercentage < 0 || maturityPercentage > 100)) {
      errors.push('Maturity percentage must be between 0 and 100.');
    }

    // accepter string[] et/ou fixedCollection, puis dédupe
    const positivePoints = dedupeStrings(input.positivePoints);
    const negativePoints = dedupeStrings(input.negativePoints);
    const description = sanitizeString(input.description);

    if (!maturityLevel &&
        maturityPercentage === undefined &&
        !(positivePoints && positivePoints.length) &&
        !(negativePoints && negativePoints.length) &&
        !description
    ) {
      errors.push(
        'Provide at least one of maturityLevel, maturityPercentage, positivePoints, negativePoints, or description for the "project-maturity" action.',
      );
    }

    const body: NormalizedMaturityBody = {
      sessionId,
      maturityLevel,
      maturityPercentage,
      positivePoints,
      negativePoints,
      description,
      ...(input.extraFields ?? {}),
    };

    return { request: { action: 'project-maturity', body }, errors, warnings };
  }

  errors.push(`Unsupported action "${action}".`);
  return { request: null, errors, warnings };
}

function removeUndefinedDeep<T>(input: T): T {
  if (Array.isArray(input)) {
    const cleaned = input
      .map((v) => removeUndefinedDeep(v as unknown))
      .filter((v): v is Exclude<typeof v, undefined> => v !== undefined);
    return cleaned as unknown as T;
  }
  if (input && typeof input === 'object') {
    const entries = Object.entries(input as Record<string, unknown>);
    const cleanedEntries: [string, unknown][] = [];
    for (const [k, v] of entries) {
      if (v === undefined) continue;
      const cleanedValue = removeUndefinedDeep(v as unknown);
      if (cleanedValue === undefined) continue;
      cleanedEntries.push([k, cleanedValue]);
    }
    return Object.fromEntries(cleanedEntries) as unknown as T;
  }
  return input;
}

async function postToProjectBuddy(baseUrl: string, request: NormalizedRequest): Promise<GenericValue> {
  const endpoint = request.action === 'location' ? '/api/locations' : '/api/project-maturity';
  const axiosClient = axios.create({
    baseURL: baseUrl,
    timeout: 10_000,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    withCredentials: false,
  });
  const body = removeUndefinedDeep(request.body);
  const response = await axiosClient.post(endpoint, body);
  return response.data as GenericValue;
}

async function handleProjectApiRequest({
  toolInput,
  baseUrl,
  manualDefaults,
  context,
}: {
  toolInput: ProjectApiToolInput;
  baseUrl: string;
  manualDefaults: Partial<ProjectApiToolInput>;
  context: ISupplyDataFunctions;
}): Promise<ToolExecutionResult> {
  let mergedInput: ProjectApiToolInput;
  try {
    mergedInput = mergeManualAndStructuredInput(manualDefaults, toolInput);
  } catch (error) {
    return {
      status: 'validation_error',
      action: (manualDefaults.action ?? 'location') as ActionType,
      validationErrors: [(error as Error).message],
    };
  }

  const nodeDefaultAction = manualDefaults.action as ActionType | undefined;
  const { request, errors, warnings } = normalizeInput(mergedInput, nodeDefaultAction);

  if (!request || errors.length) {
    return {
      status: 'validation_error',
      action: (request?.action ?? nodeDefaultAction ?? 'location') as ActionType,
      validationErrors: errors,
      validationWarnings: warnings.length ? warnings : undefined,
    };
  }

  try {
    const response = await postToProjectBuddy(baseUrl, request);
    return {
      status: 'success',
      action: request.action,
      requestBody: removeUndefinedDeep(request.body) as GenericValue,
      response,
      validationWarnings: warnings.length ? warnings : undefined,
    };
  } catch (error) {
    const axiosError = error as AxiosError;
    const message =
      axiosError.response?.data && typeof axiosError.response.data === 'object'
        ? JSON.stringify(axiosError.response.data)
        : axiosError.message;

    const logger = context.logger;
    if (logger && typeof logger.error === 'function') {
      logger.error(`[Town Hall Node] API request failed: ${message}`);
    }

    return {
      status: 'error',
      action: request.action,
      requestBody: removeUndefinedDeep(request.body) as GenericValue,
      validationWarnings: warnings.length ? warnings : undefined,
      error: {
        message,
        code: axiosError.code,
        status: axiosError.response?.status,
        data: (axiosError.response?.data ?? axiosError.cause) as GenericValue,
      },
    };
  }
}

/** --------------------
 *  TOGGLES "AI FILL" (UI SIMULÉE)
 *  -------------------- */
function isTrue(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function useField<T>(group: IDataObject, aiFlag: string, getter: () => T | undefined): T | undefined {
  if (isTrue(group?.[aiFlag])) return undefined; // l'IA remplira
  return getter();
}

/** --------------------
 *  EXTRACTION DES DEFAULTS (UI)
 *  -------------------- */
function extractManualConfiguration(
  context: ISupplyDataFunctions,
  itemIndex: number,
): { defaults: Partial<ProjectApiToolInput>; baseUrl: string } {
  const action = context.getNodeParameter('action', itemIndex, '') as ActionType | '';
  const sessionInfo = context.getNodeParameter('sessionInfo', itemIndex, {}) as IDataObject;
  const baseUrl = resolveBaseUrl(context, sessionInfo);

  const manualDefaults: Partial<ProjectApiToolInput> = {};

  if (action) manualDefaults.action = action;

  // --- Session ---
  const sessionId = useField(sessionInfo, 'sessionId_aiFill', () => sanitizeString(sessionInfo.sessionId));
  if (sessionId) manualDefaults.sessionId = sessionId;

  // --- Location ---
  const locationGroup = context.getNodeParameter('locationGroup', itemIndex, {}) as IDataObject;
  const locationAllAIFill = isTrue(locationGroup?.location_aiFill);

  if (locationGroup && !locationAllAIFill) {
    const address = useField(locationGroup, 'address_aiFill', () => sanitizeString(locationGroup.address));
    const price = useField(locationGroup, 'price_aiFill', () => toNumber(locationGroup.price));
    const surface = useField(locationGroup, 'surface_aiFill', () => sanitizeString(locationGroup.surface));
    const locationType = useField(locationGroup, 'locationType_aiFill', () => sanitizeString(locationGroup.locationType));

    const addressesFromValues = context.getNodeParameter(
      'locationGroup.addresses.values',
      itemIndex,
      [],
    ) as IDataObject[];

    const addresses = isTrue((locationGroup as any)?.addresses_aiFill)
      ? undefined
      : normalizeAddresses(
          addressesFromValues.length
            ? addressesFromValues
            : (locationGroup.addresses as IDataObject[] | IDataObject | undefined),
        );

    if (address) manualDefaults.address = address;
    if (price !== undefined) manualDefaults.price = price;
    if (surface) manualDefaults.surface = surface;
    if (locationType) manualDefaults.locationType = locationType;
    if (addresses) manualDefaults.addresses = addresses;
  }

  // --- Maturity ---
  const maturityGroup = context.getNodeParameter('maturityGroup', itemIndex, {}) as IDataObject;
  const maturityAllAIFill = isTrue(maturityGroup?.maturity_aiFill);

  if (maturityGroup && !maturityAllAIFill) {
    const maturityLevel = useField(maturityGroup, 'maturityLevel_aiFill', () => sanitizeString(maturityGroup.maturityLevel));
    const maturityPercentage = useField(maturityGroup, 'maturityPercentage_aiFill', () => toNumber(maturityGroup.maturityPercentage));

    const positivePoints = isTrue((maturityGroup as any)?.positivePoints_aiFill)
      ? undefined
      : (
          dedupePointsFromFixedCollection(
            (context.getNodeParameter(
              'maturityGroup.positivePoints.values',
              itemIndex,
              [],
            ) as IDataObject[]) || (maturityGroup.positivePoints as IDataObject[] | undefined),
          ) ?? dedupeStrings(maturityGroup.positivePoints)
        );

    const negativePoints = isTrue((maturityGroup as any)?.negativePoints_aiFill)
      ? undefined
      : (
          dedupePointsFromFixedCollection(
            (context.getNodeParameter(
              'maturityGroup.negativePoints.values',
              itemIndex,
              [],
            ) as IDataObject[]) || (maturityGroup.negativePoints as IDataObject[] | undefined),
          ) ?? dedupeStrings(maturityGroup.negativePoints)
        );

    const description = useField(maturityGroup, 'description_aiFill', () => sanitizeString(maturityGroup.description));

    if (maturityLevel) manualDefaults.maturityLevel = maturityLevel;
    if (maturityPercentage !== undefined) manualDefaults.maturityPercentage = maturityPercentage;
    if (positivePoints) manualDefaults.positivePoints = positivePoints;
    if (negativePoints) manualDefaults.negativePoints = negativePoints;
    if (description) manualDefaults.description = description;
  }

  return { defaults: manualDefaults, baseUrl };
}

/** --------------------
 *  NODE
 *  -------------------- */
export class TownHall implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Town Hall',
    name: 'townHallNode',
    group: ['transform'],
    version: 1,
    description:
      'AI Tool for Project Buddy API. Configure optional defaults here - the AI agent can override or complete any field.',
    defaults: { name: 'Town Hall' },
    icon: 'fa:project-diagram',
    subtitle: '={{ $parameter.action || "Not configured" }}',
    inputs: [],
    outputs: [NodeConnectionTypes.AiTool],
    outputNames: ['Tool'],
    properties: [
      {
        displayName: 'Action (Optional Default)',
        name: 'action',
        type: 'options',
        noDataExpression: true,
        default: '',
        options: [
          { name: 'Let AI Decide', value: '', description: 'The AI agent will choose the action dynamically' },
          { name: 'Location', value: 'location', description: 'Default to location endpoint' },
          { name: 'Project Maturity', value: 'project-maturity', description: 'Default to project maturity endpoint' },
        ],
        description: 'Pre-configure the default action. The AI can override this in the tool call.',
      },
      {
        displayName: 'Session Info',
        name: 'sessionInfo',
        type: 'collection',
        default: {},
        placeholder: 'Add Session Info',
        options: [
          { displayName: 'Session ID', name: 'sessionId', type: 'string', default: '' },
          {
            displayName: 'Let Model Define "Session ID"',
            name: 'sessionId_aiFill',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'API Base URL',
            name: 'apiBaseUrl',
            type: 'string',
            default: '',
            placeholder: 'https://project-buddy.example.com',
          },
        ],
      },
      {
        displayName: 'Location Data (Optional Defaults)',
        name: 'locationGroup',
        type: 'collection',
        default: {},
        placeholder: 'Add Location Field',
        description: 'Pre-configure location defaults. The AI can override or complete these fields.',
        options: [
          { displayName: 'Let Model Define Location Group', name: 'location_aiFill', type: 'boolean', default: false },
          { displayName: 'Address', name: 'address', type: 'string', default: '' },
          { displayName: 'Let Model Define "Address"', name: 'address_aiFill', type: 'boolean', default: false },
          { displayName: 'Price', name: 'price', type: 'number', default: undefined },
          { displayName: 'Let Model Define "Price"', name: 'price_aiFill', type: 'boolean', default: false },
          { displayName: 'Surface', name: 'surface', type: 'string', default: '' },
          { displayName: 'Let Model Define "Surface"', name: 'surface_aiFill', type: 'boolean', default: false },
          { displayName: 'Location Type', name: 'locationType', type: 'string', default: '' },
          { displayName: 'Let Model Define "Location Type"', name: 'locationType_aiFill', type: 'boolean', default: false },
          {
            displayName: 'Addresses',
            name: 'addresses',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            placeholder: 'Add Address',
            default: {},
            description: 'Pre-configure multiple addresses. AI can add more or override.',
            options: [
              {
                name: 'values',
                displayName: 'Address',
                values: [
                  { displayName: 'Address', name: 'address', type: 'string', default: '', required: true },
                  { displayName: 'Price', name: 'price', type: 'number', default: undefined },
                  { displayName: 'Surface', name: 'surface', type: 'string', default: '' },
                  { displayName: 'Location Type', name: 'locationType', type: 'string', default: '' },
                ],
              },
            ],
          },
          { displayName: 'Let Model Define "Addresses"', name: 'addresses_aiFill', type: 'boolean', default: false },
        ],
      },
      {
        displayName: 'Project Maturity Data (Optional Defaults)',
        name: 'maturityGroup',
        type: 'collection',
        default: {},
        placeholder: 'Add Project Maturity Field',
        description: 'Pre-configure maturity defaults. The AI can override or complete these fields.',
        options: [
          { displayName: 'Let Model Define Maturity Group', name: 'maturity_aiFill', type: 'boolean', default: false },
          { displayName: 'Maturity Level', name: 'maturityLevel', type: 'string', default: '' },
          { displayName: 'Let Model Define "Maturity Level"', name: 'maturityLevel_aiFill', type: 'boolean', default: false },
          { displayName: 'Maturity Percentage', name: 'maturityPercentage', type: 'number', default: undefined },
          { displayName: 'Let Model Define "Maturity Percentage"', name: 'maturityPercentage_aiFill', type: 'boolean', default: false },
          {
            displayName: 'Positive Points',
            name: 'positivePoints',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            placeholder: 'Add Positive Point',
            options: [{ name: 'values', displayName: 'Point', values: [{ displayName: 'Text', name: 'text', type: 'string', default: '' }]}],
          },
          { displayName: 'Let Model Define "Positive Points"', name: 'positivePoints_aiFill', type: 'boolean', default: false },
          {
            displayName: 'Negative Points',
            name: 'negativePoints',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            placeholder: 'Add Negative Point',
            options: [{ name: 'values', displayName: 'Point', values: [{ displayName: 'Text', name: 'text', type: 'string', default: '' }]}],
          },
          { displayName: 'Let Model Define "Negative Points"', name: 'negativePoints_aiFill', type: 'boolean', default: false },
          { displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 4 }, default: '' },
          { displayName: 'Let Model Define "Description"', name: 'description_aiFill', type: 'boolean', default: false },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const { defaults, baseUrl } = extractManualConfiguration(this, itemIndex);
    const tool = new ProjectApiTool({
      context: this,
      baseUrl,
      manualDefaults: defaults,
      description:
        'Send location or project maturity data to Project Buddy API. All parameters configured in the node are defaults - you can override or complete any field dynamically.',
    });
    return { response: tool };
  }
}

/**
 * USAGE:
 *
 * 1. Connect this node's Tool output to your AI Agent
 * 2. Optionally set defaults (or leave empty to let the AI choose/fill)
 * 3. The AI can:
 *    - Use/override defaults
 *    - Add unlimited addresses/points
 *    - Omit "action": it will be inferred from provided fields
 *
 * Examples:
 * - Auto action (location inferred):
 *   { "addresses": ["12 rue des Fleurs, Paris", "3 Avenue Victor Hugo, Lyon"], "price": 2000 }
 *
 * - Auto action (maturity inferred):
 *   { "maturityLevel": "advanced", "positivePoints": ["Great traction","Solid team"], "maturityPercentage": 78 }
 *
 * - Mixed with extra fields:
 *   { "addresses": [{ "address":"1 Main St", "surface":"120m²"}], "extraFields": { "source":"townhall-ui" } }
 */