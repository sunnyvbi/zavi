import { useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, Mail, MapPin, Phone } from "lucide-react";
import { usePublicForm } from "../../zavi/form";
import { Container, Section, SectionHeader, type SectionTone } from "../ui/layout";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";

type Submission = { name: string; email?: string; body: string };

export function Contact({
  eyebrow,
  title = "Get in touch",
  subtitle = "Send us a message and we will get back to you.",
  phone,
  email,
  address,
  tone,
  id = "contact",
  "data-zavi-section": marker,
}: {
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  phone?: string;
  email?: string;
  address?: string;
  tone?: SectionTone;
  id?: string;
  "data-zavi-section"?: string;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [body, setBody] = useState("");
  const form = usePublicForm<Submission>("submissions");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const values: Submission = { name: name.trim(), body: body.trim() };
    if (from.trim()) values.email = from.trim();
    void form.submit(values);
  }

  const details = [
    phone ? { icon: Phone, label: phone, href: `tel:${phone.replace(/[^\d+]/g, "")}` } : null,
    email ? { icon: Mail, label: email, href: `mailto:${email}` } : null,
    address ? { icon: MapPin, label: address, href: undefined } : null,
  ].filter((d): d is NonNullable<typeof d> => d !== null);

  return (
    <Section tone={tone} id={id} data-zavi-section={marker}>
      <Container className="grid gap-12 lg:grid-cols-5 lg:gap-16">
        <div className="lg:col-span-2">
          <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} align="left" className="mb-8 md:mb-8" />
          {details.length ? (
            <ul className="space-y-4">
              {details.map((d) => (
                <li key={d.label} className="flex items-start gap-3">
                  <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                    <d.icon aria-hidden className="size-5" />
                  </span>
                  {d.href ? (
                    <a href={d.href} className="break-all pt-2 hover:underline">
                      {d.label}
                    </a>
                  ) : (
                    <span className="pt-2">{d.label}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Card className="p-6 md:p-8 lg:col-span-3">
          {form.status === "sent" ? (
            <div data-zavi="contact-sent" role="status" className="flex flex-col items-center py-10 text-center">
              <CheckCircle2 aria-hidden className="size-12 text-success" />
              <p className="mt-4 text-xl font-semibold">Thanks, your message was sent.</p>
              <p className="mt-2 text-muted-foreground">We will be in touch soon.</p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="contact-name">Name</Label>
                  <Input
                    id="contact-name"
                    data-zavi="contact-name"
                    required
                    maxLength={80}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contact-email">Email</Label>
                  <Input
                    id="contact-email"
                    data-zavi="contact-email"
                    type="email"
                    maxLength={320}
                    autoComplete="email"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="contact-body">Message</Label>
                <Textarea
                  id="contact-body"
                  data-zavi="contact-body"
                  required
                  maxLength={2000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
              {form.fields}
              <Button data-zavi="contact-submit" type="submit" size="lg" disabled={form.status === "sending"} className="w-full sm:w-auto">
                {form.status === "sending" ? "Sending..." : "Send message"}
              </Button>
              {form.status === "error" ? (
                <p data-zavi="contact-error" role="alert" className="text-sm text-danger">
                  {form.error}
                </p>
              ) : null}
            </form>
          )}
        </Card>
      </Container>
    </Section>
  );
}
