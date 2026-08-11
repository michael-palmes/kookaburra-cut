import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SceneOverviewEntityRow,
  SceneOverviewGroupHeader,
  SceneOverviewPicker,
  SceneOverviewSectionHeader,
  SceneOverviewSettingRow,
} from "./SceneOverview";

const icon = createElement("svg", { "aria-hidden": true });

describe("SceneOverview semantic markup", () => {
  it("keeps the entity body and chevron as separate labelled open controls", () => {
    const html = renderToStaticMarkup(
      createElement(SceneOverviewEntityRow, {
        rowId: "device-1",
        domain: "devices",
        label: "Main iPhone",
        value: "iPhone 17 Pro",
        leading: icon,
        selected: true,
        onOpen: vi.fn(),
      }),
    );

    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('data-overview-row-id="device-1"');
    expect(html).toContain('data-overview-domain="devices"');
    expect(html).toContain('class="inspector-scene-overview-entity selected"');
    expect(html).toContain(
      'class="inspector-scene-overview-entity-body" aria-label="Open Main iPhone" aria-current="true"',
    );
    expect(html).toContain(
      'class="inspector-scene-overview-entity-open" aria-label="Open Main iPhone"',
    );
    expect(html).toContain("Main iPhone");
    expect(html).toContain("iPhone 17 Pro");
  });

  it("labels an unselected entity body as an open action", () => {
    const html = renderToStaticMarkup(
      createElement(SceneOverviewEntityRow, {
        rowId: "device-1",
        domain: "devices",
        label: "Main iPhone",
        selected: false,
        onOpen: vi.fn(),
      }),
    );

    expect(html).toContain(
      'class="inspector-scene-overview-entity-body" aria-label="Open Main iPhone"',
    );
    expect(html).not.toContain("aria-current");
  });

  it("opens the entity body whether or not it is already selected", () => {
    const onOpen = vi.fn();
    const clickBody = (selected: boolean) => {
      const row = SceneOverviewEntityRow({
        rowId: "device-1",
        domain: "devices",
        label: "Main iPhone",
        selected,
        onOpen,
      });
      const [body] = row.props.children as ReactElement<{ onClick: () => void }>[];
      body.props.onClick();
    };

    clickBody(false);
    expect(onOpen).toHaveBeenCalledOnce();

    clickBody(true);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("exposes pointer and keyboard context-menu entry on both row controls", () => {
    const onContextMenu = vi.fn();
    const html = renderToStaticMarkup(
      createElement(SceneOverviewEntityRow, {
        rowId: "device-1",
        domain: "devices",
        label: "Main iPhone",
        selected: false,
        onOpen: vi.fn(),
        onContextMenu,
      }),
    );
    expect(html.match(/aria-keyshortcuts="Shift\+F10"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-haspopup="menu"');

    const row = SceneOverviewEntityRow({
      rowId: "device-1",
      domain: "devices",
      label: "Main iPhone",
      selected: false,
      onOpen: vi.fn(),
      onContextMenu,
    });
    const [body] = row.props.children as ReactElement<{
      onContextMenu: (event: {
        preventDefault: () => void;
        stopPropagation: () => void;
        clientX: number;
        clientY: number;
        currentTarget: HTMLButtonElement;
      }) => void;
      onKeyDown: (event: {
        key: string;
        shiftKey: boolean;
        preventDefault: () => void;
        stopPropagation: () => void;
        currentTarget: HTMLButtonElement;
      }) => void;
    }>[];
    const trigger = {
      getBoundingClientRect: () => ({ left: 100, right: 180, bottom: 72 }),
    } as HTMLButtonElement;
    body.props.onContextMenu({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 44,
      clientY: 55,
      currentTarget: trigger,
    });
    body.props.onKeyDown({
      key: "F10",
      shiftKey: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: trigger,
    });

    expect(onContextMenu).toHaveBeenNthCalledWith(1, {
      x: 44,
      y: 55,
      returnFocus: trigger,
    });
    expect(onContextMenu).toHaveBeenNthCalledWith(2, {
      x: 124,
      y: 72,
      returnFocus: trigger,
    });
  });

  it("renders group and section add icons as separate accessible buttons", () => {
    const groupHtml = renderToStaticMarkup(
      createElement(SceneOverviewGroupHeader, {
        label: "Devices",
        icon,
        onAdd: vi.fn(),
        addLabel: "Add device",
      }),
    );
    const sectionHtml = renderToStaticMarkup(
      createElement(SceneOverviewSectionHeader, {
        label: "Content",
        onAdd: vi.fn(),
        addLabel: "Add content",
        expanded: true,
        controls: "scene-content-picker",
      }),
    );

    expect(groupHtml.match(/<button/g)).toHaveLength(1);
    expect(groupHtml).toContain("Devices");
    expect(groupHtml).toContain(
      'class="inspector-scene-overview-group-add" aria-label="Add device"',
    );
    expect(groupHtml).toContain('<svg width="16" height="16"');
    expect(groupHtml).toContain('aria-hidden="true"');
    expect(sectionHtml).toContain(
      'class="inspector-scene-overview-add" aria-label="Add content" aria-expanded="true" aria-controls="scene-content-picker" aria-haspopup="dialog"',
    );
  });

  it("keeps an actionable group body separate from its add control", () => {
    const html = renderToStaticMarkup(
      createElement(SceneOverviewGroupHeader, {
        label: "Devices",
        icon,
        onOpen: vi.fn(),
        openLabel: "Arrange devices",
        onAdd: vi.fn(),
        addLabel: "Add device",
      }),
    );

    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain(
      'class="inspector-scene-overview-group-main" aria-label="Arrange devices"',
    );
    expect(html).toContain('class="inspector-scene-overview-group-add" aria-label="Add device"');
  });

  it("uses the complete setting row as its control and exposes disabled context", () => {
    const enabledHtml = renderToStaticMarkup(
      createElement(SceneOverviewSettingRow, {
        rowId: "lighting",
        label: "Lighting",
        value: "Studio soft",
        icon,
        onOpen: vi.fn(),
      }),
    );
    const disabledHtml = renderToStaticMarkup(
      createElement(SceneOverviewSettingRow, {
        rowId: "overlay",
        label: "Overlay",
        icon,
        disabled: true,
        disabledReason: "Create an overlay first",
        onOpen: vi.fn(),
      }),
    );

    expect(enabledHtml.match(/<button/g)).toHaveLength(1);
    expect(enabledHtml).toContain(
      'class="inspector-scene-overview-setting" data-overview-row-id="lighting"',
    );
    expect(enabledHtml).toContain("Studio soft");
    expect(enabledHtml).toContain("inspector-scene-overview-setting-chevron");
    expect(disabledHtml.match(/<button/g)).toHaveLength(1);
    expect(disabledHtml).toContain('data-overview-row-id="overlay" disabled=""');
    expect(disabledHtml).toContain('title="Create an overlay first"');
    expect(disabledHtml).not.toContain("inspector-scene-overview-setting-chevron");
  });

  it("shows picker disablement explanations without hiding available choices", () => {
    const html = renderToStaticMarkup(
      createElement(SceneOverviewPicker, {
        id: "scene-content-picker",
        items: [
          {
            id: "image",
            label: "Image",
            icon,
            disabledReason: "Create an overlay first",
            onPick: vi.fn(),
          },
          {
            id: "device",
            label: "Device",
            icon,
            onPick: vi.fn(),
          },
        ],
      }),
    );

    expect(html).toContain('id="scene-content-picker"');
    expect(html).toContain('role="dialog" aria-label="Add content"');
    expect(html.match(/inspector-scene-overview-picker-item/g)).toHaveLength(2);
    expect(html).toContain(
      'aria-disabled="true" aria-describedby="scene-content-picker-image-status" title="Create an overlay first"',
    );
    expect(html).toContain(
      '<span id="scene-content-picker-image-status" class="inspector-scene-overview-picker-status">Create an overlay first</span>',
    );
    expect(html).toContain('title="Add device"');
    expect(html).toContain("Image");
    expect(html).toContain("Device");
  });
});
