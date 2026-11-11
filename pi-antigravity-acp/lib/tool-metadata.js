/** Preserve a real Host parameter with the same name; remove only bridge metadata. */
export function hostArguments(args, original) {
    const properties = original?.inputSchema.properties;
    if (properties !== undefined && Object.hasOwn(properties, 'toolSummary'))
        return args;
    const result = { ...args };
    delete result.toolSummary;
    return result;
}
