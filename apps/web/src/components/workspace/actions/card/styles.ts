const titleType = "min-w-0 break-words pr-8 text-ca-dialog-h font-semibold tracking-[-0.3px] text-ca-xdark [overflow-wrap:anywhere]";
const titleClamp = "line-clamp-3 [@container(min-width:36rem)]:line-clamp-2";

export const cardText = {
  title: `${titleType} ${titleClamp}`,
  titleType,
  titleClamp,
  eyebrow: "flex flex-wrap items-center gap-x-1.5 pr-10 text-ca-eyebrow text-ca-secondary",
  body: "min-w-0 break-words text-[14px] leading-[22px] text-ca-dark [overflow-wrap:anywhere]",
  label: "mb-1.5 text-ca-eyebrow font-medium text-ca-secondary",
  footnote: "mt-2 text-ca-action text-ca-secondary",
  status: "text-ca-action font-medium",
};

const press = "transition-[background-color,border-color,transform,box-shadow] duration-ca-press ease-ca-standard active:scale-[0.96] focus-visible:shadow-ca-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export const cardButton = {
  base: `inline-flex min-h-9 max-w-full items-center justify-center gap-1.5 whitespace-normal rounded-full px-4 text-center text-xs font-semibold ${press}`,
  primary: "bg-ca-action text-ca-on-action hover:bg-ca-action-hover",
  secondary: "border border-ca-strong bg-ca-bg text-ca-primary hover:bg-ca-hover",
  ghost: "text-ca-secondary hover:bg-ca-hover hover:text-ca-primary",
};

export const cardLink = `inline-flex min-h-8 items-center gap-1 rounded-sm text-ca-action font-medium text-ca-primary underline underline-offset-4 hover:no-underline focus-visible:shadow-ca-focus focus-visible:outline-none`;

export const cardDisclosure = `mt-2 inline-flex min-h-8 items-center rounded-sm text-xs font-medium text-ca-primary underline underline-offset-4 hover:no-underline focus-visible:shadow-ca-focus focus-visible:outline-none`;

export const cardIconButton = `inline-flex size-9 items-center justify-center rounded-full ${press}`;
