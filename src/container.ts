export class InjectionToken<T> {
    private readonly type!: (value: T) => T;

    public constructor(public readonly description: string) {}
}

export type ClassToken<T> = abstract new (...args: never[]) => T;
export type Token<T> = InjectionToken<T> | ClassToken<T>;
export type Factory<T> = (container: Container) => T;

interface Registration {
    factory: () => unknown;
    singleton: boolean;
}

export class Container {
    private readonly registrations = new Map<object, Registration>();
    private readonly singletons = new Map<object, unknown>();

    public registerInstance<T>(token: Token<T>, instance: T): void {
        this.assertNotRegistered(token);
        this.singletons.set(token, instance);
    }

    public registerFactory<T>(
        token: Token<T>,
        factory: Factory<T>,
        singleton = true
    ): void {
        this.assertNotRegistered(token);
        this.registrations.set(token, {
            factory: () => factory(this),
            singleton,
        });
    }

    public has<T>(token: Token<T>): boolean {
        return this.singletons.has(token) || this.registrations.has(token);
    }

    // Used in teardownContainer to avoid calling resolve and instantiating
    public getIfInstantiated<T>(token: Token<T>): T | undefined {
        if (!this.singletons.has(token)) {
            return undefined;
        }

        return this.singletons.get(token) as T;
    }

    public resolve<T>(token: Token<T>): T {
        if (this.singletons.has(token)) {
            return this.singletons.get(token) as T;
        }

        const registration = this.registrations.get(token);

        if (!registration) {
            throw new Error(`Service not registered: ${this.describeToken(token)}`);
        }

        const instance = registration.factory() as T;

        if (registration.singleton) {
            this.singletons.set(token, instance);
        }

        return instance;
    }

    private assertNotRegistered<T>(token: Token<T>): void {
        if (this.has(token)) {
            throw new Error(`Service already registered: ${this.describeToken(token)}`);
        }
    }

    private describeToken<T>(token: Token<T>): string {
        return token instanceof InjectionToken ? token.description : token.name;
    }
}
