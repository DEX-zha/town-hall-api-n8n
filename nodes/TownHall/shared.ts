import axios, { AxiosError } from 'axios';
import type { GenericValue, IDataObject, ISupplyDataFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

export type NormalizedAddress = IDataObject & {
  address: string;
  price?: number;
  surface?: string;
  locationType?: string;
};

export type NormalizedLocationBody = IDataObject & {
  sessionId?: string;
  address?: string;
  price?: number;
  surface?: string;
  locationType?: string;
  addresses: NormalizedAddress[];
};

export type NormalizedMaturityBody = IDataObject & {
  sessionId?: string;
  maturityLevel?: string;
  maturityPercentage?: number;
  positivePoints?: string[];
  negativePoints?: string[];
  description?: string;
};

export interface ToolExecutionResult extends IDataObject {
  status: 'success' | 'validation_error' | 'error';
  action: 'location' | 'project-maturity';
  statusMessage?: string;
  requestBody?: GenericValue;
  response?: GenericValue;
  validationWarnings?: string[];
  validationErrors?: string[];
  error?: IDataObject;
}

export interface ApiErrorPayload extends IDataObject {
  message: string;
  code?: string;
  status?: number;
  data?: GenericValue;
}

export function resolveBaseUrl(context: ISupplyDataFunctions, sessionInfo: IDataObject): string {
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

export function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

export function dedupeStrings(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const cleaned = values
    .map((v) => sanitizeString(v))
    .filter((s): s is string => typeof s === 'string');
  return cleaned.length ? Array.from(new Set(cleaned)) : undefined;
}

export function dedupePointsFromFixedCollection(
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

export function normalizeAddresses(raw: unknown): NormalizedAddress[] | undefined {
  const maybeArray = Array.isArray(raw)
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

export function removeUndefinedDeep<T>(input: T): T {
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

export async function postToProjectBuddy(baseUrl: string, endpoint: string, body: unknown): Promise<GenericValue> {
  const axiosClient = axios.create({
    baseURL: baseUrl,
    timeout: 10_000,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    withCredentials: false,
  });
  const response = await axiosClient.post(endpoint, removeUndefinedDeep(body));
  return response.data as GenericValue;
}

export function toAxiosErrorPayload(error: AxiosError): ApiErrorPayload {
  const payload: ApiErrorPayload = {
    message:
      error.response?.data && typeof error.response.data === 'object'
        ? JSON.stringify(error.response.data)
        : error.message,
  };
  if (error.code) payload.code = error.code;
  if (error.response?.status) payload.status = error.response.status;
  if (error.response?.data ?? error.cause) {
    payload.data = (error.response?.data ?? error.cause) as GenericValue;
  }
  return payload;
}

export function isTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function useField<T>(
  group: IDataObject,
  aiFlag: string,
  getter: () => T | undefined,
): T | undefined {
  if (isTrue(group?.[aiFlag])) return undefined;
  return getter();
}

export function formatToolResult(result: ToolExecutionResult): string {
  const summaryParts: string[] = [];
  if (result.statusMessage) summaryParts.push(result.statusMessage);
  if (result.validationErrors?.length) summaryParts.push(`Errors: ${result.validationErrors.join('; ')}`);
  if (result.validationWarnings?.length) summaryParts.push(`Warnings: ${result.validationWarnings.join('; ')}`);

  const payload: Record<string, unknown> = {
    status: result.status,
    success: result.status === 'success',
    action: result.action,
    message: summaryParts.length ? summaryParts.join(' ') : undefined,
    validationErrors: result.validationErrors?.length ? result.validationErrors : undefined,
    validationWarnings: result.validationWarnings?.length ? result.validationWarnings : undefined,
    requestBody: result.requestBody ?? undefined,
    response: result.response ?? undefined,
    error: result.error ?? undefined,
    statusMessage: result.statusMessage ?? undefined,
    raw: result,
    timestamp: new Date().toISOString(),
  };

  return JSON.stringify(payload);
}
