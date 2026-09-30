type RequestUrlOverride = (param: any) => Promise<any>;

let requestUrlOverride: RequestUrlOverride | undefined;

export function setRequestUrlOverride(override?: RequestUrlOverride): void {
    requestUrlOverride = override;
}

export function getRequestUrlOverride(): RequestUrlOverride | undefined {
    return requestUrlOverride;
}
