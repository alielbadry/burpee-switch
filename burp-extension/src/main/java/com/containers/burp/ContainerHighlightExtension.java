package com.containers.burp;

import burp.api.montoya.BurpExtension;
import burp.api.montoya.MontoyaApi;
import burp.api.montoya.core.Annotations;
import burp.api.montoya.core.HighlightColor;
import burp.api.montoya.http.message.requests.HttpRequest;
import burp.api.montoya.proxy.http.InterceptedResponse;
import burp.api.montoya.proxy.http.ProxyResponseHandler;
import burp.api.montoya.proxy.http.ProxyResponseReceivedAction;
import burp.api.montoya.proxy.http.ProxyResponseToBeSentAction;

import java.util.Locale;

public final class ContainerHighlightExtension implements BurpExtension {
    private static final String NAME_HEADER = "X-Container-Name";
    private static final String COLOR_HEADER = "X-Container-Color";
    private static final String TAB_HEADER = "X-Container-Tab";
    private static final int MAX_NOTE_LENGTH = 300;

    @Override
    public void initialize(MontoyaApi api) {
        api.extension().setName("Container Color Highlighter");
        api.proxy().registerResponseHandler(new ContainerResponseHandler());
        api.logging().logToOutput(
            "Container Color Highlighter loaded. Enable Burp Suite headers in the browser "
                + "extension to highlight Proxy HTTP history rows by container."
        );
    }

    private static final class ContainerResponseHandler implements ProxyResponseHandler {
        @Override
        public ProxyResponseReceivedAction handleResponseReceived(InterceptedResponse response) {
            HttpRequest request = response.initiatingRequest();
            if (request == null) request = response.request();
            if (request == null) {
                return ProxyResponseReceivedAction.continueWith(response);
            }

            String name = clean(request.headerValue(NAME_HEADER));
            if (name.isEmpty()) {
                return ProxyResponseReceivedAction.continueWith(response);
            }

            String tab = clean(request.headerValue(TAB_HEADER));
            String marker = tab.isEmpty()
                ? "Container: " + name
                : "Container: " + name + " (tab " + tab + ")";
            if (marker.length() > MAX_NOTE_LENGTH) {
                marker = marker.substring(0, MAX_NOTE_LENGTH);
            }

            Annotations annotations = response.annotations();
            String existing = annotations.notes();
            String notes = existing == null || existing.isBlank()
                ? marker
                : existing.contains(marker)
                    ? existing
                    : existing + " | " + marker;

            HighlightColor color = colorFor(request.headerValue(COLOR_HEADER));
            Annotations updated = annotations.withNotes(notes).withHighlightColor(color);
            return ProxyResponseReceivedAction.continueWith(response, updated);
        }

        @Override
        public ProxyResponseToBeSentAction handleResponseToBeSent(InterceptedResponse response) {
            return ProxyResponseToBeSentAction.continueWith(response);
        }
    }

    private static String clean(String value) {
        if (value == null) return "";
        return value.replaceAll("[\\r\\n]+", " ").trim();
    }

    private static HighlightColor colorFor(String value) {
        if (value == null) return HighlightColor.GRAY;
        return switch (value.trim().toLowerCase(Locale.ROOT)) {
            case "red" -> HighlightColor.RED;
            case "orange" -> HighlightColor.ORANGE;
            case "yellow" -> HighlightColor.YELLOW;
            case "green" -> HighlightColor.GREEN;
            case "cyan", "teal" -> HighlightColor.CYAN;
            case "blue" -> HighlightColor.BLUE;
            case "pink" -> HighlightColor.PINK;
            case "purple", "magenta", "violet" -> HighlightColor.MAGENTA;
            case "grey", "gray" -> HighlightColor.GRAY;
            default -> HighlightColor.GRAY;
        };
    }
}
