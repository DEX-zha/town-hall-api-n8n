import type { AxiosError } from 'axios';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type {
  GenericValue,
  IDataObject,
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
  NormalizedAddress,
  NormalizedLocationBody,
  ToolExecutionResult,
  isTrue,
  normalizeAddresses,
  postToProjectBuddy,
  removeUndefinedDeep,
  resolveBaseUrl,
  sanitizeString,
  toAxiosErrorPayload,
  toNumber,
  useField,
} from './shared';

const locationToolSchema = z.object({
  sessionId: z.string().describe('Optional session identifier to correlate multiple calls.').optional(),
  address: z.string().describe('Primary address string if only one location is provided.').optional(),
  addresses: z
    .array(
      z.union([
        z.string().describe('Raw address string (the model will enrich if needed).'),
        z.object({
          address: z.string().describe('Full address text for the location.'),
          price: z
            .union([z.number(), z.string()])
            .describe('Monthly or total price. Accepts number or string like "1200€".')
            .optional(),
          surface: z.string().describe('Surface or area description, e.g. "85m²".').optional(),
          locationType: z.string().describe('Location type such as "rent", "sale", "office".').optional(),
        }),
      ]),
    )
    .describe(
      'Provide one or multiple locations. Use raw strings for simple cases or objects when price, surface, or type must accompany each address.',
    )
    .optional(),
  price: z
    .union([z.number(), z.string()])
    .describe('Global price if a single address is supplied. Prefer numbers; strings also accepted.')
    .optional(),
  surface: z.string().describe('Global surface value when only one address is present.').optional(),
  locationType: z.string().describe('High-level location type (e.g. rent, sale, office).').optional(),
  extraFields: z
    .record(z.string(), z.unknown())
    .describe('Additional JSON key/value pairs to pass through to the API unchanged.')
    .optional(),
});

export type LocationToolInput = z.infer<typeof locationToolSchema>;

interface LocationToolOptions {
  context: ISupplyDataFunctions;
  baseUrl: string;
  manualDefaults: Partial<LocationToolInput>;
  name?: string;
  description?: string;
}

class TownHallLocationTool extends DynamicStructuredTool<typeof locationToolSchema> {
  constructor(options: LocationToolOptions) {
    super({
      name: options.name ?? 'town_hall_location_tool',
      description:
        options.description ??
        'Send structured location data to the Project Buddy API. Always include at least one address. Fill price, surface, and location type when they are known or can be sensibly estimated. Leave fields out rather than invent implausible data.',
      schema: locationToolSchema,
      func: async (input: unknown) => {
        const parsed = locationToolSchema.parse(input);
        return JSON.stringify(
          await handleLocationRequest({
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

function mergeLocationDefaults(
  manualDefaults: Partial<LocationToolInput>,
  toolInput?: LocationToolInput | null,
): LocationToolInput {
  const structured = (toolInput ?? {}) as Partial<LocationToolInput>;
  return {
    sessionId: structured.sessionId ?? manualDefaults.sessionId,
    address: structured.address ?? manualDefaults.address,
    addresses: structured.addresses ?? manualDefaults.addresses,
    price: structured.price ?? manualDefaults.price,
    surface: structured.surface ?? manualDefaults.surface,
    locationType: structured.locationType ?? manualDefaults.locationType,
    extraFields: { ...(manualDefaults.extraFields ?? {}), ...(structured.extraFields ?? {}) },
  };
}

function normalizeLocationInput(
  input: LocationToolInput,
): { body: NormalizedLocationBody | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let sessionId = sanitizeString(input.sessionId);
  if (input.sessionId && !sessionId) {
    warnings.push('Provided sessionId is blank after trimming and was ignored.');
    sessionId = undefined;
  }

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

  normalizedAddresses = normalizedAddresses.filter((entry) => entry.address.length);
  if (!normalizedAddresses.length) {
    errors.push('At least one valid address is required.');
  }

  const price =
    normalizedAddresses.length === 1
      ? normalizedAddresses[0].price ?? toNumber(input.price)
      : toNumber(input.price);

  const surface =
    normalizedAddresses.length === 1
      ? normalizedAddresses[0].surface ?? sanitizeString(input.surface)
      : sanitizeString(input.surface);

  const locationType =
    normalizedAddresses.length === 1
      ? normalizedAddresses[0].locationType ?? sanitizeString(input.locationType)
      : sanitizeString(input.locationType);

  if (errors.length) {
    return { body: null, errors, warnings };
  }

  const extraFields = (input.extraFields ?? {}) as IDataObject;

  const body: NormalizedLocationBody = {
    sessionId,
    address: singleAddress ?? normalizedAddresses[0]?.address,
    price,
    surface,
    locationType,
    addresses: normalizedAddresses,
    ...extraFields,
  };

  return { body, errors, warnings };
}

async function handleLocationRequest({
  toolInput,
  baseUrl,
  manualDefaults,
  context,
}: {
  toolInput: LocationToolInput;
  baseUrl: string;
  manualDefaults: Partial<LocationToolInput>;
  context: ISupplyDataFunctions;
}): Promise<ToolExecutionResult> {
  let mergedInput: LocationToolInput;
  try {
    mergedInput = mergeLocationDefaults(manualDefaults, toolInput);
  } catch (error) {
    const message = (error as Error).message;
    return {
      status: 'validation_error',
      action: 'location',
      statusMessage: `Unable to merge location defaults: ${message}`,
      validationErrors: [message],
    };
  }

  const { body, errors, warnings } = normalizeLocationInput(mergedInput);
  if (!body || errors.length) {
    const messageParts = [
      'Validation failed for location payload.',
      errors.length ? `Errors: ${errors.join('; ')}` : null,
      warnings.length ? `Warnings: ${warnings.join('; ')}` : null,
    ].filter(Boolean);

    return {
      status: 'validation_error',
      action: 'location',
      statusMessage: messageParts.join(' '),
      validationErrors: errors,
      validationWarnings: warnings.length ? warnings : undefined,
    };
  }

  const cleanedBody = removeUndefinedDeep(body) as GenericValue;

  try {
    const response = await postToProjectBuddy(baseUrl, '/api/locations', cleanedBody);
    const messageParts = ['Location data posted successfully.'];
    if (warnings.length) messageParts.push(`Warnings: ${warnings.join('; ')}`);
    return {
      status: 'success',
      action: 'location',
      statusMessage: messageParts.join(' '),
      requestBody: cleanedBody,
      response,
      validationWarnings: warnings.length ? warnings : undefined,
    };
  } catch (error) {
    const payload = toAxiosErrorPayload(error as AxiosError);
    const logger = context.logger;
    if (logger && typeof logger.error === 'function') {
      logger.error(`[Town Hall Location] API request failed: ${payload.message}`);
    }

    return {
      status: 'error',
      action: 'location',
      statusMessage: `Location request failed: ${payload.message}`,
      requestBody: cleanedBody,
      validationWarnings: warnings.length ? warnings : undefined,
      error: payload,
    };
  }
}

function extractManualConfiguration(
  context: ISupplyDataFunctions,
  itemIndex: number,
): { defaults: Partial<LocationToolInput>; baseUrl: string } {
  const sessionInfo = context.getNodeParameter('sessionInfo', itemIndex, {}) as IDataObject;
  const baseUrl = resolveBaseUrl(context, sessionInfo);

  const manualDefaults: Partial<LocationToolInput> = {};

  const sessionId = useField(sessionInfo, 'sessionId_aiFill', () => sanitizeString(sessionInfo.sessionId));
  if (sessionId) manualDefaults.sessionId = sessionId;

  const locationGroup = context.getNodeParameter('locationGroup', itemIndex, {}) as IDataObject;
  const locationAllAIFill = isTrue(locationGroup?.location_aiFill);

  if (locationGroup && !locationAllAIFill) {
    const address = useField(locationGroup, 'address_aiFill', () => sanitizeString(locationGroup.address));
    const price = useField(locationGroup, 'price_aiFill', () => toNumber(locationGroup.price));
    const surface = useField(locationGroup, 'surface_aiFill', () => sanitizeString(locationGroup.surface));
    const locationType = useField(locationGroup, 'locationType_aiFill', () =>
      sanitizeString(locationGroup.locationType),
    );

    const addressesFromValues = context.getNodeParameter(
      'locationGroup.addresses.values',
      itemIndex,
      [],
    ) as IDataObject[];

    const addresses = isTrue((locationGroup as IDataObject)?.addresses_aiFill)
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

  return { defaults: manualDefaults, baseUrl };
}

export class TownHallLocation implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Town Hall Location',
    name: 'townHallLocationNode',
    group: ['transform'],
    version: 1,
    description:
      'AI Tool for sending location data to the Project Buddy API. Configure optional defaults here – the AI agent can override or complete any field.',
    defaults: { name: 'Town Hall Location' },
    icon: 'fa:project-diagram',
    subtitle: 'Location tool',
    inputs: [],
    outputs: [NodeConnectionTypes.AiTool],
    outputNames: ['Tool'],
    properties: [
      {
        displayName: 'Session Info',
        name: 'sessionInfo',
        type: 'collection',
        default: {},
        placeholder: 'Add Session Info',
        options: [
          {
            displayName: 'Session ID',
            name: 'sessionId',
            type: 'string',
            default: '',
            description: 'Identifier shared across multiple calls so the API can link them together.',
          },
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
            description: 'Base URL of your Project Buddy instance. Leave blank to rely on environment variables.',
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
          {
            displayName: 'Address',
            name: 'address',
            type: 'string',
            default: '',
            description: 'Primary address when only one location is needed (e.g. "12 rue des Fleurs, Paris").',
          },
          { displayName: 'Let Model Define "Address"', name: 'address_aiFill', type: 'boolean', default: false },
          {
            displayName: 'Price',
            name: 'price',
            type: 'number',
            default: undefined,
            description: 'Price associated with the location. Leave empty to let the model estimate.',
          },
          { displayName: 'Let Model Define "Price"', name: 'price_aiFill', type: 'boolean', default: false },
          {
            displayName: 'Surface',
            name: 'surface',
            type: 'string',
            default: '',
            description: 'Surface or area (e.g. "85m²").',
          },
          { displayName: 'Let Model Define "Surface"', name: 'surface_aiFill', type: 'boolean', default: false },
          {
            displayName: 'Location Type',
            name: 'locationType',
            type: 'string',
            default: '',
            description: 'Type or status of the location (e.g. "rent", "sale", "office").',
          },
          {
            displayName: 'Let Model Define "Location Type"',
            name: 'locationType_aiFill',
            type: 'boolean',
            default: false,
          },
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
                  {
                    displayName: 'Address',
                    name: 'address',
                    type: 'string',
                    default: '',
                    required: true,
                    description: 'Full address for this entry.',
                  },
                  {
                    displayName: 'Price',
                    name: 'price',
                    type: 'number',
                    default: undefined,
                    description: 'Price linked to this address only.',
                  },
                  {
                    displayName: 'Surface',
                    name: 'surface',
                    type: 'string',
                    default: '',
                    description: 'Surface/area for this address.',
                  },
                  {
                    displayName: 'Location Type',
                    name: 'locationType',
                    type: 'string',
                    default: '',
                    description: 'Specific location type for this entry.',
                  },
                ],
              },
            ],
          },
          { displayName: 'Let Model Define "Addresses"', name: 'addresses_aiFill', type: 'boolean', default: false },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const { defaults, baseUrl } = extractManualConfiguration(this, itemIndex);
    const tool = new TownHallLocationTool({
      context: this,
      baseUrl,
      manualDefaults: defaults,
      description:
        'Send location data to Project Buddy API. Always supply at least one address and enrich with price, surface, and location type when they are known or inferred confidently. Omit uncertain fields instead of guessing wildly.',
    });
    return { response: tool };
  }
}
