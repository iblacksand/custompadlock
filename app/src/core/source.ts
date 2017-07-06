import { request, Method, AjaxError } from "./ajax";
import { FileManager, HTML5FileManager, CordovaFileManager, NodeFileManager } from "./file";
import { Settings } from "./data";
import { Container } from "./crypto";
import { isCordova, isElectron } from "./platform";

export interface Source {
    get(): Promise<string>;
    set(data: string): Promise<void>;
    clear(): Promise<void>;
}

export class MemorySource implements Source {

    constructor(private data = "") {}

    async get(): Promise<string> {
        return this.data;
    }

    async set(data: string): Promise<void> {
        this.data = data;
    }

    async clear(): Promise<void> {
        this.data = "";
    }

}

export class LocalStorageSource implements Source {

    constructor(public key: string) {}

    async get(): Promise<string> {
        return localStorage.getItem(this.key) || "";
    };

    async set(data: string): Promise<void> {
        localStorage.setItem(this.key, data);
    };

    async clear(): Promise<void> {
        localStorage.removeItem(this.key);
    };

}

export class AjaxSource implements Source {

    constructor(private _url: string) {}

    get url() {
        return this._url;
    }

    request(method: Method, url: string, data?: string, headers?: Map<string, string>): Promise<XMLHttpRequest> {
        return request(method, url, data, headers);
    }

    get(): Promise<string> {
        return this.request("GET", this.url).then(req => req.responseText);
    }

    set(data: string): Promise<void> {
        return this.request("POST", this.url, data).then(() => {});
    }

    clear(): Promise<void> {
        return this.request("DELETE", this.url).then(() => {});
    }

}

export interface CloudAuthToken {
    email: string;
    token: string;
    id: string;
    // Activation url returned by server. Only used for testing
    actUrl?: string;
}

export class CloudError {
    constructor(
        public code:
            "invalid_auth_token" |
            "expired_auth_token" |
            "internal_server_error" |
            "deprecated_api_version" |
            "subscription_required" |
            "account_not_found" |
            "rate_limit_exceeded" |
            "json_error",
        public message?: string
    ) {};
}

export class CloudSource extends AjaxSource {

    urlForPath(path: string) {
        // Remove trailing slashes
        const host = this.settings.syncHostUrl.replace(/\/+$/, "");
        return `${host}/${path}/`;
    }

    constructor(public settings: Settings) {
        super("");
    }

    get url() {
        return this.urlForPath("store");
    }

    async request(method: Method, url: string, data?: string, headers?: Map<string, string>): Promise<XMLHttpRequest> {

        headers = headers || new Map<string, string>();

        headers.set("Accept", "application/vnd.padlock;version=1");
        if (this.settings.syncEmail && this.settings.syncToken) {
            headers.set("Authorization",
                "AuthToken " + this.settings.syncEmail + ":" + this.settings.syncToken);
        }

        // headers.set("X-Client-Version", padlock.version);
        // headers.set("X-Client-Platform", padlock.platform.getPlatformName());

        let req: XMLHttpRequest;
        try {
            req = await super.request(method, url, data, headers);
        } catch (e) {
            const err = <AjaxError>e;
            if (err.code === "client_error" || err.code === "server_error") {
                let parsedErr;
                try {
                    parsedErr = JSON.parse(err.request.responseText);
                } catch (e) {
                    throw new CloudError("json_error");
                }
                throw new CloudError(parsedErr.error, parsedErr.message);
            } else {
                throw err;
            }
        }

        this.settings.syncSubStatus = req.getResponseHeader("X-Sub-Status") || "";
        try {
            this.settings.syncTrialEnd =
                parseInt(req.getResponseHeader("X-Sub-Trial-End") || "0", 10);
        } catch (e) {
            //
        }
        return req;
    }

    async requestAuthToken(email: string, create = false): Promise<CloudAuthToken> {
        const req = await this.request(
            create ? "POST" : "PUT",
            this.urlForPath("auth"),
            "email=" + encodeURIComponent(email),
            new Map<string, string>().set("Content-Type", "application/x-www-form-urlencoded")
        );

        let authToken: CloudAuthToken;
        try {
            authToken = <CloudAuthToken>JSON.parse(req.responseText);
        } catch (e) {
            throw new CloudError("json_error");
        }
        try {
            authToken.actUrl = req.getResponseHeader("X-Test-Act-Url") || undefined;
        } catch (e) {}
        this.settings.syncEmail = authToken.email;
        this.settings.syncToken = authToken.token;
        return authToken;
    };

    async testCredentials(): Promise<boolean> {
        try {
            await this.get();
            return true;
        } catch (e) {
            const err = <AjaxError|CloudError>e;
            if (err.code === "invalid_auth_token") {
                return false;
            } else {
                throw err;
            }
        }
    }

}

export class EncryptedSource implements Source {

    private container?: Container;

    public password: string;

    constructor(public source: Source) {}

    async get(): Promise<string> {
        let data = await this.source.get();
        if (data == "") {
            return "";
        }

        let cont = this.container = Container.fromJSON(data);
        cont.password = this.password;

        return await cont.get();
    }

    async set(data: string): Promise<void> {
        // Reuse container if possible
        let cont = this.container = this.container || new Container();
        cont.password = this.password;
        cont.set(data);

        return this.source.set(cont.toJSON());
    }

    async hasData(): Promise<boolean> {
        const data = await this.source.get();
        return data !== "";
    }

    clear(): Promise<void> {
        this.password = "";
        if (this.container) {
            this.container.clear();
        }
        delete this.container;
        return this.source.clear();
    }

}

export class FileSource implements Source {

    private fileManager: FileManager;

    constructor(private filePath: string) {
        this.fileManager = isElectron() ? new NodeFileManager() :
            isCordova() ? new CordovaFileManager() : new HTML5FileManager();
    }

    get(): Promise<string> {
        return this.fileManager.read(this.filePath);
    }

    set(data: string): Promise<void> {
        return this.fileManager.write(this.filePath, data);
    }

    clear(): Promise<void> {
        return this.fileManager.write(this.filePath, "");
    }

}
