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
  NormalizedMaturityBody,
  ToolExecutionResult,
  dedupePointsFromFixedCollection,
  dedupeStrings,
  isTrue,
  postToProjectBuddy,
  removeUndefinedDeep,
  resolveBaseUrl,
  sanitizeString,
  toAxiosErrorPayload,
  toNumber,
  useField,
} from './shared';

const projectMaturityToolSchema = z.object({
  sessionId: z.string().describe('Optional session identifier.').optional(),
  maturityLevel: z.string().optional(),
  maturityPercentage: z.union([z.number(), z.string()]).optional(),
  positivePoints: z.array(z.string()).optional(),
  negativePoints: z.array(z.string()).optional(),
  description: z.string().optional(),
  extraFields: z.record(z.string(), z.unknown()).optional(),
});

export type ProjectMaturityToolInput = z.infer<typeof projectMaturityToolSchema>;

interface ProjectMaturityToolOptions {
  context: ISupplyDataFunctions;
  baseUrl: string;
  manualDefaults: Partial<ProjectMaturityToolInput>;
  name?: string;
  description?: string;
}

class TownHallProjectMaturityTool extends DynamicStructuredTool<typeof projectMaturityToolSchema> {
  constructor(options: ProjectMaturityToolOptions) {
    super({
      name: options.name ?? 'town_hall_project_maturity_tool',
      description:
        options.description ??
        'Send structured project maturity data to the Project Buddy API. The AI can provide all parameters dynamically and they will be merged with the defaults configured on the node.',
      schema: projectMaturityToolSchema,
      func: async (input: unknown) => {
        const parsed = projectMaturityToolSchema.parse(input);
        return JSON.stringify(
          await handleProjectMaturityRequest({
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

function mergeProjectMaturityDefaults(
  manualDefaults: Partial<ProjectMaturityToolInput>,
  toolInput?: ProjectMaturityToolInput | null,
): ProjectMaturityToolInput {
  const structured = (toolInput ?? {}) as Partial<ProjectMaturityToolInput>;
  return {
    sessionId: structured.sessionId ?? manualDefaults.sessionId,
    maturityLevel: structured.maturityLevel ?? manualDefaults.maturityLevel,
    maturityPercentage: structured.maturityPercentage ?? manualDefaults.maturityPercentage,
    positivePoints:
      structured.positivePoints?.length || manualDefaults.positivePoints?.length
        ? Array.from(
            new Set([...(manualDefaults.positivePoints ?? []), ...(structured.positivePoints ?? [])]),
          )
        : undefined,
    negativePoints:
      structured.negativePoints?.length || manualDefaults.negativePoints?.length
        ? Array.from(
            new Set([...(manualDefaults.negativePoints ?? []), ...(structured.negativePoints ?? [])]),
          )
        : undefined,
    description: structured.description ?? manualDefaults.description,
    extraFields: { ...(manualDefaults.extraFields ?? {}), ...(structured.extraFields ?? {}) },
  };
}

function normalizeProjectMaturityInput(
  input: ProjectMaturityToolInput,
): { body: NormalizedMaturityBody | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let sessionId = sanitizeString(input.sessionId);
  if (input.sessionId && !sessionId) {
    warnings.push('Provided sessionId is blank after trimming and was ignored.');
    sessionId = undefined;
  }

  const maturityLevel = sanitizeString(input.maturityLevel);
  const maturityPercentage = toNumber(input.maturityPercentage);
  if (maturityPercentage !== undefined && (maturityPercentage < 0 || maturityPercentage > 100)) {
    errors.push('Maturity percentage must be between 0 and 100.');
  }

  const positivePoints = dedupeStrings(input.positivePoints);
  const negativePoints = dedupeStrings(input.negativePoints);
  const description = sanitizeString(input.description);

  if (
    !maturityLevel &&
    maturityPercentage === undefined &&
    !(positivePoints && positivePoints.length) &&
    !(negativePoints && negativePoints.length) &&
    !description
  ) {
    errors.push(
      'Provide at least one of maturityLevel, maturityPercentage, positivePoints, negativePoints, or description.',
    );
  }

  if (errors.length) {
    return { body: null, errors, warnings };
  }

  const extraFields = (input.extraFields ?? {}) as IDataObject;

  const body: NormalizedMaturityBody = {
    sessionId,
    maturityLevel,
    maturityPercentage,
    positivePoints,
    negativePoints,
    description,
    ...extraFields,
  };

  return { body, errors, warnings };
}

async function handleProjectMaturityRequest({
  toolInput,
  baseUrl,
  manualDefaults,
  context,
}: {
  toolInput: ProjectMaturityToolInput;
  baseUrl: string;
  manualDefaults: Partial<ProjectMaturityToolInput>;
  context: ISupplyDataFunctions;
}): Promise<ToolExecutionResult> {
  let mergedInput: ProjectMaturityToolInput;
  try {
    mergedInput = mergeProjectMaturityDefaults(manualDefaults, toolInput);
  } catch (error) {
    return {
      status: 'validation_error',
      action: 'project-maturity',
      validationErrors: [(error as Error).message],
    };
  }

  const { body, errors, warnings } = normalizeProjectMaturityInput(mergedInput);
  if (!body || errors.length) {
    return {
      status: 'validation_error',
      action: 'project-maturity',
      validationErrors: errors,
      validationWarnings: warnings.length ? warnings : undefined,
    };
  }

  const cleanedBody = removeUndefinedDeep(body) as GenericValue;

  try {
    const response = await postToProjectBuddy(baseUrl, '/api/project-maturity', cleanedBody);
    return {
      status: 'success',
      action: 'project-maturity',
      requestBody: cleanedBody,
      response,
      validationWarnings: warnings.length ? warnings : undefined,
    };
  } catch (error) {
    const payload = toAxiosErrorPayload(error as AxiosError);
    const logger = context.logger;
    if (logger && typeof logger.error === 'function') {
      logger.error(`[Town Hall Project Maturity] API request failed: ${payload.message}`);
    }

    return {
      status: 'error',
      action: 'project-maturity',
      requestBody: cleanedBody,
      validationWarnings: warnings.length ? warnings : undefined,
      error: payload,
    };
  }
}

function extractManualConfiguration(
  context: ISupplyDataFunctions,
  itemIndex: number,
): { defaults: Partial<ProjectMaturityToolInput>; baseUrl: string } {
  const sessionInfo = context.getNodeParameter('sessionInfo', itemIndex, {}) as IDataObject;
  const baseUrl = resolveBaseUrl(context, sessionInfo);

  const manualDefaults: Partial<ProjectMaturityToolInput> = {};

  const sessionId = useField(sessionInfo, 'sessionId_aiFill', () => sanitizeString(sessionInfo.sessionId));
  if (sessionId) manualDefaults.sessionId = sessionId;

  const maturityGroup = context.getNodeParameter('maturityGroup', itemIndex, {}) as IDataObject;
  const maturityAllAIFill = isTrue(maturityGroup?.maturity_aiFill);

  if (maturityGroup && !maturityAllAIFill) {
    const maturityLevel = useField(maturityGroup, 'maturityLevel_aiFill', () =>
      sanitizeString(maturityGroup.maturityLevel),
    );
    const maturityPercentage = useField(maturityGroup, 'maturityPercentage_aiFill', () =>
      toNumber(maturityGroup.maturityPercentage),
    );

    const positivePoints = isTrue((maturityGroup as IDataObject)?.positivePoints_aiFill)
      ? undefined
      : dedupePointsFromFixedCollection(
          (context.getNodeParameter(
            'maturityGroup.positivePoints.values',
            itemIndex,
            [],
          ) as IDataObject[]) || (maturityGroup.positivePoints as IDataObject[] | undefined),
        ) ?? dedupeStrings(maturityGroup.positivePoints);

    const negativePoints = isTrue((maturityGroup as IDataObject)?.negativePoints_aiFill)
      ? undefined
      : dedupePointsFromFixedCollection(
          (context.getNodeParameter(
            'maturityGroup.negativePoints.values',
            itemIndex,
            [],
          ) as IDataObject[]) || (maturityGroup.negativePoints as IDataObject[] | undefined),
        ) ?? dedupeStrings(maturityGroup.negativePoints);

    const description = useField(maturityGroup, 'description_aiFill', () =>
      sanitizeString(maturityGroup.description),
    );

    if (maturityLevel) manualDefaults.maturityLevel = maturityLevel;
    if (maturityPercentage !== undefined) manualDefaults.maturityPercentage = maturityPercentage;
    if (positivePoints) manualDefaults.positivePoints = positivePoints;
    if (negativePoints) manualDefaults.negativePoints = negativePoints;
    if (description) manualDefaults.description = description;
  }

  return { defaults: manualDefaults, baseUrl };
}

export class TownHallProjectMaturity implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Town Hall Project Maturity',
    name: 'townHallProjectMaturityNode',
    group: ['transform'],
    version: 1,
    description:
      'AI Tool for sending project maturity data to the Project Buddy API. Configure optional defaults here – the AI agent can override or complete any field.',
    defaults: { name: 'Town Hall Project Maturity' },
    icon: 'fa:project-diagram',
    subtitle: 'Project maturity tool',
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
        displayName: 'Project Maturity Data (Optional Defaults)',
        name: 'maturityGroup',
        type: 'collection',
        default: {},
        placeholder: 'Add Project Maturity Field',
        description: 'Pre-configure maturity defaults. The AI can override or complete these fields.',
        options: [
          { displayName: 'Let Model Define Maturity Group', name: 'maturity_aiFill', type: 'boolean', default: false },
          { displayName: 'Maturity Level', name: 'maturityLevel', type: 'string', default: '' },
          {
            displayName: 'Let Model Define "Maturity Level"',
            name: 'maturityLevel_aiFill',
            type: 'boolean',
            default: false,
          },
          { displayName: 'Maturity Percentage', name: 'maturityPercentage', type: 'number', default: undefined },
          {
            displayName: 'Let Model Define "Maturity Percentage"',
            name: 'maturityPercentage_aiFill',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'Positive Points',
            name: 'positivePoints',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            placeholder: 'Add Positive Point',
            options: [
              {
                name: 'values',
                displayName: 'Point',
                values: [{ displayName: 'Text', name: 'text', type: 'string', default: '' }],
              },
            ],
          },
          {
            displayName: 'Let Model Define "Positive Points"',
            name: 'positivePoints_aiFill',
            type: 'boolean',
            default: false,
          },
          {
            displayName: 'Negative Points',
            name: 'negativePoints',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            placeholder: 'Add Negative Point',
            options: [
              {
                name: 'values',
                displayName: 'Point',
                values: [{ displayName: 'Text', name: 'text', type: 'string', default: '' }],
              },
            ],
          },
          {
            displayName: 'Let Model Define "Negative Points"',
            name: 'negativePoints_aiFill',
            type: 'boolean',
            default: false,
          },
          { displayName: 'Description', name: 'description', type: 'string', typeOptions: { rows: 4 }, default: '' },
          {
            displayName: 'Let Model Define "Description"',
            name: 'description_aiFill',
            type: 'boolean',
            default: false,
          },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const { defaults, baseUrl } = extractManualConfiguration(this, itemIndex);
    const tool = new TownHallProjectMaturityTool({
      context: this,
      baseUrl,
      manualDefaults: defaults,
      description:
        'Send project maturity data to Project Buddy API. All parameters configured in the node are defaults – the AI agent can override or complete any field dynamically.',
    });
    return { response: tool };
  }
}
