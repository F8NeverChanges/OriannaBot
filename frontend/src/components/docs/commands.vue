<template>
    <div class="docs">
        <div class="header">
            <div class="title">Command Reference</div>
            <div class="subtitle"><i>"{{ subtitle }}."</i></div>
        </div>

        <div class="body">
            <div v-if="loading" class="loader">Loading...</div>

            <template v-else>
                <div class="command">
                    <p>To invoke any of Orianna Bot's commands, simply mention her with the appropriate keyword and any optional settings. For example, to refresh your own scores and statistics, you can use <code>@Orianna Bot refresh</code>. Have any ideas for new commands or adjustments to existing commands? <a href="https://github.com/molenzwiebel/oriannabot/issues">File an issue on GitHub!</a></p>
                </div>

                <div class="command" v-for="command in commands">
                    <h2>{{ command.name }}</h2>
                    <h4 v-html="getKeywords(command)"></h4>

                    <div v-html="marked(command.description)"></div>
                </div>
            </template>
        </div>
    </div>
</template>

<script lang="ts">
    import * as marked from "marked";
    const SUBTITLES = ["Ravage", "Pulse", "Protect", "Throw"];

    export default {
        data: () => ({
            marked,
            loading: true,
            commands: [],
            subtitle: SUBTITLES[Math.floor(Math.random() * SUBTITLES.length)]
        }),
        async mounted() {
            this.commands = await this.$root.get("/api/v1/commands");
            this.loading = false;
        },
        methods: {
            getKeywords(command: any) {
                return `Keywords: ` + command.keywords.map((x: string) => `<code>${x}</code>`).join(", ");
            }
        }
    };
</script>

<style lang="stylus">
    title-width = 840px

    @import "./docs-common.styl"

    .command
        padding 10px
        max-width title-width
        margin 0 auto
        font-family Roboto

        & h2
            color #3596ff
            font-weight 400
            font-size 1.8em
            margin 0

        & h4
            margin-top 6px
            font-weight 400
            font-size 1.15em
            padding-bottom 0.3em
            border-bottom 1px solid #eaecef

        & p, & li, & b
            font-size 1.05em
            line-height 1.3em

        & h4 > code
            font-size 0.8em

        & code
            font-size 14px
            color #f0506e
            white-space nowrap
            padding 2px 6px
            background #f8f8f8
</style>