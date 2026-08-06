export interface ReplayQueryScopeLike {
  frameLocator?(selector: string): ReplayQueryScopeLike;
  locator?(selector: string): ReplayLocatorLike;
  getByRole?(role: string, options?: { name?: string }): ReplayLocatorLike;
  getByLabel?(text: string): ReplayLocatorLike;
  getByTestId?(testId: string): ReplayLocatorLike;
  getByText?(text: string): ReplayLocatorLike;
  getByAltText?(text: string): ReplayLocatorLike;
  getByTitle?(text: string): ReplayLocatorLike;
  getByPlaceholder?(text: string): ReplayLocatorLike;
}

export interface ReplayLocatorLike extends ReplayQueryScopeLike {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
}

export interface ReplayPageLike extends ReplayQueryScopeLike {}
