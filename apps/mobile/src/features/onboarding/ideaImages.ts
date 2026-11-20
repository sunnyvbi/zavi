let images: string[] = [];

export const getIdeaImages = (): string[] => images;
export const setIdeaImages = (next: string[]): void => {
  images = next;
};
export const clearIdeaImages = (): void => {
  images = [];
};
